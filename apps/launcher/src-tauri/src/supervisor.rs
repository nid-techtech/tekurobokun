// ServiceSupervisor（imple 3節）：6つのサービスの起動・停止・再起動と状態。
// - 子プロセスはサービスごとのJob Objectに入れ、停止はジョブごと終了する（job.rs）
// - 起動前にポートの使用を確かめ、使用中なら失敗にする
// - 標準出力・標準エラーは、サービスごとのファイル（{logDir}/{id}.log）に追記する
// - 起動したら「読み込み中」、readyUrl（なければポート）が応答したら「稼働中」
// - ［すべて起動］は、サービスごとの依存（after）がすべて稼働中になってから起動する。
//   失敗したサービスに依存するものは「起動待ち」のまま止まる（失敗したものを手で起動して稼働中になれば、続きを起動する）
// 状態が変わるたびに、全サービスの状態を通知する（画面はそれで描き直す）。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::config::{LauncherConfig, ServiceConfig};
use crate::http;
use crate::job::Process;

const TICK: Duration = Duration::from_millis(250);
const PROBE_TIMEOUT: Duration = Duration::from_millis(1000);
/// 再起動で、ポートが空くのを待つ上限
const RESTART_RELEASE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Running,
    Standby,
    Stopped,
    Loading,
    Waiting,
    Failed,
    Down,
}

/// 失敗の理由。文言は画面が辞書で組み立てる。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Reason {
    PortInUse { port: u16 },
    Exited { code: Option<i32> },
    Spawn { detail: String },
    Timeout { seconds: u64 },
    NotConfigured,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceView {
    pub id: String,
    pub detail: String,
    pub port: Option<u16>,
    pub standby: bool,
    pub state: State,
    /// 起動した時刻（UNIX時刻のミリ秒）。稼働時間の表示に使う
    pub started_at: Option<u64>,
    pub reason: Option<Reason>,
    pub log_path: String,
}

struct Slot {
    cfg: ServiceConfig,
    state: State,
    reason: Option<Reason>,
    started: Option<(Instant, u64)>,
    process: Option<Process>,
    /// 起動のたびに増やす（起動の確認の結果が、古い起動のものでないかを見分ける）
    generation: u64,
}

impl Slot {
    fn idle_state(&self) -> State {
        if self.cfg.standby {
            State::Standby
        } else {
            State::Stopped
        }
    }

    fn fail(&mut self, reason: Reason) {
        self.state = State::Failed;
        self.reason = Some(reason);
        self.started = None;
    }

    fn view(&self, log_dir: &Path) -> ServiceView {
        ServiceView {
            id: self.cfg.id.clone(),
            detail: self.cfg.detail.clone(),
            port: self.cfg.port,
            standby: self.cfg.standby,
            state: self.state,
            started_at: self.started.map(|(_, ms)| ms),
            reason: self.reason.clone(),
            log_path: log_path(log_dir, &self.cfg.id)
                .to_string_lossy()
                .into_owned(),
        }
    }
}

struct Inner {
    slots: Vec<Slot>,
    /// ［すべて起動］で、まだ起動していないサービス（記載順）
    plan: Vec<String>,
}

impl Inner {
    fn index(&self, id: &str) -> Result<usize, String> {
        self.slots
            .iter()
            .position(|s| s.cfg.id == id)
            .ok_or_else(|| format!("unknown service: {id}"))
    }
}

pub type Notify = Box<dyn Fn(Vec<ServiceView>) + Send + Sync>;

pub struct Supervisor {
    inner: Mutex<Inner>,
    log_dir: PathBuf,
    notify: Notify,
    last: Mutex<Vec<ServiceView>>,
}

pub fn log_path(log_dir: &Path, id: &str) -> PathBuf {
    log_dir.join(format!("{id}.log"))
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// UNIX時刻のミリ秒を、JSTの「YYYY-MM-DD HH:MM:SS」にする（ログの区切りの行）。
fn jst_string(ms: u64) -> String {
    let secs = ms / 1000 + 9 * 3600;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // 1970-01-01からの日数を年月日に（Howard Hinnantのcivil_from_days）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60
    )
}

fn open_log(log_dir: &Path, id: &str) -> std::io::Result<File> {
    fs::create_dir_all(log_dir)?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path(log_dir, id))
}

/// サービスを起動する。失敗したら、スロットを失敗にする。
fn spawn_slot(slot: &mut Slot, log_dir: &Path) {
    slot.reason = None;
    let cfg = slot.cfg.clone();
    if cfg.program.is_empty() {
        slot.fail(Reason::NotConfigured);
        return;
    }
    if let Some(port) = cfg.port {
        if http::port_in_use(port) {
            slot.fail(Reason::PortInUse { port });
            return;
        }
    }
    let mut log = match open_log(log_dir, &cfg.id) {
        Ok(f) => f,
        Err(e) => {
            slot.fail(Reason::Spawn {
                detail: e.to_string(),
            });
            return;
        }
    };
    let now = epoch_ms();
    let _ = writeln!(
        log,
        "===== {} start: {} {} =====",
        jst_string(now),
        cfg.program,
        cfg.args.join(" ")
    );
    let stdout = match log.try_clone() {
        Ok(f) => f,
        Err(e) => {
            slot.fail(Reason::Spawn {
                detail: e.to_string(),
            });
            return;
        }
    };
    let mut cmd = Command::new(&cfg.program);
    cmd.args(&cfg.args)
        .current_dir(&cfg.cwd)
        .envs(&cfg.env)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(
            log.try_clone()
                .map(Stdio::from)
                .unwrap_or_else(|_| Stdio::null()),
        );
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // コンソールのウィンドウを出さない
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.spawn() {
        Ok(child) => {
            let (process, job_error) = Process::adopt(child);
            if let Some(e) = job_error {
                let _ = writeln!(log, "[launcher] job object: {e}");
            }
            slot.process = Some(process);
            slot.state = State::Loading;
            slot.started = Some((Instant::now(), now));
            slot.generation += 1;
        }
        Err(e) => {
            let _ = writeln!(log, "[launcher] spawn failed: {e}");
            slot.fail(Reason::Spawn {
                detail: e.to_string(),
            });
        }
    }
}

/// 起動の確認の対象。
struct ProbeTask {
    index: usize,
    generation: u64,
    url: String,
    port: Option<u16>,
    delay: Duration,
    elapsed: Duration,
    timeout: Duration,
}

fn is_ready(task: &ProbeTask) -> bool {
    if !task.url.is_empty() {
        http::probe(&task.url, PROBE_TIMEOUT)
    } else if let Some(port) = task.port {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
    } else {
        task.elapsed >= task.delay
    }
}

/// ポートが空くまで待つ。空いたらtrue。
pub fn wait_port_free(port: Option<u16>, timeout: Duration) -> bool {
    let Some(port) = port else { return true };
    let deadline = Instant::now() + timeout;
    loop {
        if !http::port_in_use(port) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(200));
    }
}

impl Supervisor {
    pub fn new(config: &LauncherConfig, notify: Notify) -> Arc<Supervisor> {
        let slots = config
            .services
            .iter()
            .map(|cfg| {
                let mut slot = Slot {
                    cfg: cfg.clone(),
                    state: State::Stopped,
                    reason: None,
                    started: None,
                    process: None,
                    generation: 0,
                };
                slot.state = slot.idle_state();
                slot
            })
            .collect();
        Arc::new(Supervisor {
            inner: Mutex::new(Inner {
                slots,
                plan: Vec::new(),
            }),
            log_dir: PathBuf::from(&config.log_dir),
            notify,
            last: Mutex::new(Vec::new()),
        })
    }

    /// 状態を見回るスレッドを始める。
    pub fn spawn_ticker(self: &Arc<Self>) {
        let me = Arc::clone(self);
        thread::spawn(move || loop {
            me.tick();
            thread::sleep(TICK);
        });
    }

    pub fn views(&self) -> Vec<ServiceView> {
        let inner = self.inner.lock().unwrap();
        inner.slots.iter().map(|s| s.view(&self.log_dir)).collect()
    }

    pub fn log_path_of(&self, id: &str) -> Result<PathBuf, String> {
        let inner = self.inner.lock().unwrap();
        inner.index(id)?;
        Ok(log_path(&self.log_dir, id))
    }

    fn emit_if_changed(&self) {
        let views = self.views();
        let mut last = self.last.lock().unwrap();
        if *last != views {
            *last = views.clone();
            drop(last);
            (self.notify)(views);
        }
    }

    /// 1つのサービスを起動する（手での起動。依存は待たない）。
    pub fn start(&self, id: &str) -> Result<(), String> {
        {
            let mut inner = self.inner.lock().unwrap();
            let i = inner.index(id)?;
            inner.plan.retain(|p| p != id);
            let slot = &mut inner.slots[i];
            if slot.process.is_none() {
                spawn_slot(slot, &self.log_dir);
            }
        }
        self.emit_if_changed();
        Ok(())
    }

    /// 1つのサービスを止める。markを渡すと、止めたあとの状態をそれにする（正→副の切り替えの「応答なし」）。
    pub fn stop(&self, id: &str, mark: Option<State>) -> Result<(), String> {
        let process = {
            let mut inner = self.inner.lock().unwrap();
            let i = inner.index(id)?;
            inner.plan.retain(|p| p != id);
            let slot = &mut inner.slots[i];
            slot.state = mark.unwrap_or_else(|| slot.idle_state());
            slot.reason = None;
            slot.started = None;
            slot.process.take()
        };
        if let Some(p) = process {
            p.kill();
        }
        self.emit_if_changed();
        Ok(())
    }

    pub fn restart(&self, id: &str) -> Result<(), String> {
        let port = {
            let inner = self.inner.lock().unwrap();
            inner.slots[inner.index(id)?].cfg.port
        };
        self.stop(id, None)?;
        wait_port_free(port, RESTART_RELEASE_TIMEOUT);
        self.start(id)
    }

    /// ［すべて起動］。待機のサービスと、同じポートをほかのサービスが使っているもの（副に切り替えたあとの正）は除く。
    pub fn start_all(&self) {
        {
            let mut inner = self.inner.lock().unwrap();
            let busy_ports: Vec<u16> = inner
                .slots
                .iter()
                .filter(|s| matches!(s.state, State::Running | State::Loading))
                .filter_map(|s| s.cfg.port)
                .collect();
            let mut plan = Vec::new();
            for slot in &mut inner.slots {
                if slot.cfg.standby || matches!(slot.state, State::Running | State::Loading) {
                    continue;
                }
                if slot.cfg.port.is_some_and(|p| busy_ports.contains(&p)) {
                    continue;
                }
                slot.state = State::Waiting;
                slot.reason = None;
                plan.push(slot.cfg.id.clone());
            }
            inner.plan = plan;
        }
        self.tick();
    }

    /// ［すべて停止］。後ろから止める。
    pub fn stop_all(&self) {
        let processes: Vec<Process> = {
            let mut inner = self.inner.lock().unwrap();
            inner.plan.clear();
            inner
                .slots
                .iter_mut()
                .rev()
                .filter_map(|slot| {
                    slot.state = slot.idle_state();
                    slot.reason = None;
                    slot.started = None;
                    slot.process.take()
                })
                .collect()
        };
        for p in processes {
            p.kill();
        }
        self.emit_if_changed();
    }

    /// 正→副の切り替え（と、正に戻す）：fromを止め、ポートが空くのを待ち、さらにsettle待ってから、toを起動する。
    pub fn switch(
        &self,
        from: &str,
        to: &str,
        mark_from: State,
        release_timeout: Duration,
        settle: Duration,
    ) -> Result<(), String> {
        let port = {
            let inner = self.inner.lock().unwrap();
            inner.index(to)?;
            inner.slots[inner.index(from)?].cfg.port
        };
        self.stop(from, Some(mark_from))?;
        if !wait_port_free(port, release_timeout) {
            return Err(format!("port {} was not released", port.unwrap_or(0)));
        }
        thread::sleep(settle);
        self.start(to)
    }

    /// ランチャーを閉じるとき。Windowsではジョブのハンドルが閉じられて終了するが、ほかのOSのために明示的に止める。
    pub fn kill_all(&self) {
        let processes: Vec<Process> = {
            let mut inner = self.inner.lock().unwrap();
            inner
                .slots
                .iter_mut()
                .filter_map(|s| s.process.take())
                .collect()
        };
        for p in processes {
            p.kill();
        }
    }

    /// 見回り：終了したプロセス、起動の確認、［すべて起動］の続き。
    pub fn tick(&self) {
        // 1. 終了したプロセスを見つけ、起動の確認の対象を集める
        let tasks: Vec<ProbeTask> = {
            let mut inner = self.inner.lock().unwrap();
            let mut tasks = Vec::new();
            for (index, slot) in inner.slots.iter_mut().enumerate() {
                if let Some(p) = slot.process.as_mut() {
                    if let Ok(Some(status)) = p.child.try_wait() {
                        slot.process = None;
                        if matches!(slot.state, State::Loading | State::Running) {
                            slot.fail(Reason::Exited {
                                code: status.code(),
                            });
                        }
                    }
                }
                if slot.state == State::Loading {
                    if let Some((at, _)) = slot.started {
                        tasks.push(ProbeTask {
                            index,
                            generation: slot.generation,
                            url: slot.cfg.ready_url.clone(),
                            port: slot.cfg.port,
                            delay: Duration::from_millis(slot.cfg.ready_delay_ms),
                            elapsed: at.elapsed(),
                            timeout: Duration::from_millis(slot.cfg.start_timeout_ms),
                        });
                    }
                }
            }
            tasks
        };

        // 2. 起動の確認（ロックの外で）
        let results: Vec<(ProbeTask, bool)> = tasks
            .into_iter()
            .map(|t| {
                let ready = is_ready(&t);
                (t, ready)
            })
            .collect();

        // 3. 結果を反映し、［すべて起動］の続きを起動する
        let timed_out: Vec<Process> = {
            let mut inner = self.inner.lock().unwrap();
            let mut timed_out = Vec::new();
            for (task, ready) in results {
                let slot = &mut inner.slots[task.index];
                if slot.state != State::Loading || slot.generation != task.generation {
                    continue;
                }
                if ready {
                    slot.state = State::Running;
                } else if task.elapsed >= task.timeout {
                    if let Some(p) = slot.process.take() {
                        timed_out.push(p);
                    }
                    slot.fail(Reason::Timeout {
                        seconds: task.timeout.as_secs(),
                    });
                }
            }
            let plan = inner.plan.clone();
            let mut remaining = Vec::new();
            for id in plan {
                let Ok(i) = inner.index(&id) else { continue };
                let deps_ready = inner.slots[i].cfg.after.iter().all(|dep| {
                    inner
                        .index(dep)
                        .map(|d| inner.slots[d].state == State::Running)
                        .unwrap_or(false)
                });
                let slot = &mut inner.slots[i];
                if matches!(slot.state, State::Running | State::Loading) {
                    continue;
                }
                if deps_ready {
                    spawn_slot(slot, &self.log_dir);
                } else {
                    slot.state = State::Waiting;
                    remaining.push(id);
                }
            }
            inner.plan = remaining;
            timed_out
        };
        for p in timed_out {
            p.kill();
        }
        self.emit_if_changed();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{FailoverConfig, HeartbeatConfig};
    use std::collections::HashMap;
    use std::net::TcpListener;

    fn service(
        id: &str,
        program: &str,
        args: &[&str],
        port: Option<u16>,
        after: &[&str],
    ) -> ServiceConfig {
        ServiceConfig {
            id: id.into(),
            detail: String::new(),
            program: program.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            env: HashMap::new(),
            port,
            after: after.iter().map(|a| a.to_string()).collect(),
            standby: false,
            ready_url: String::new(),
            ready_delay_ms: 300,
            start_timeout_ms: 10_000,
        }
    }

    fn config(services: Vec<ServiceConfig>, name: &str) -> LauncherConfig {
        LauncherConfig {
            repo_dir: String::new(),
            log_dir: std::env::temp_dir()
                .join(format!(
                    "tekurobo_launcher_test_{name}_{}",
                    std::process::id()
                ))
                .to_string_lossy()
                .into_owned(),
            start_all_on_launch: false,
            autostart: false,
            admin_port: 8788,
            search_monthly_limit: 1000,
            heartbeat: HeartbeatConfig {
                url: String::new(),
                interval_ms: 1000,
                timeout_ms: 500,
                failures: 3,
            },
            failover: FailoverConfig {
                from: "a".into(),
                to: "b".into(),
                release_timeout_ms: 1000,
                settle_ms: 0,
            },
            services,
        }
    }

    /// 長く動き続けるコマンド。
    fn sleeper() -> (&'static str, Vec<&'static str>) {
        if cfg!(windows) {
            ("cmd", vec!["/C", "ping -n 30 127.0.0.1 >NUL"])
        } else {
            ("sleep", vec!["30"])
        }
    }

    fn state_of(sup: &Supervisor, id: &str) -> State {
        sup.views().into_iter().find(|v| v.id == id).unwrap().state
    }

    fn wait_for(sup: &Supervisor, id: &str, want: State) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while state_of(sup, id) != want {
            assert!(
                Instant::now() < deadline,
                "{id} did not become {want:?} (now {:?})",
                state_of(sup, id)
            );
            sup.tick();
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn starts_in_dependency_order_and_stops() {
        let (prog, args) = sleeper();
        let cfg = config(
            vec![
                service("a", prog, &args, None, &[]),
                service("b", prog, &args, None, &["a"]),
                service("c", prog, &args, None, &[]),
            ],
            "order",
        );
        let sup = Supervisor::new(&cfg, Box::new(|_| {}));
        sup.start_all();
        // aとcはすぐに起動し、bはaが稼働中になるまで起動待ち
        assert_eq!(state_of(&sup, "a"), State::Loading);
        assert_eq!(state_of(&sup, "b"), State::Waiting);
        assert_eq!(state_of(&sup, "c"), State::Loading);
        wait_for(&sup, "a", State::Running);
        wait_for(&sup, "b", State::Running);
        sup.stop_all();
        for id in ["a", "b", "c"] {
            assert_eq!(state_of(&sup, id), State::Stopped);
        }
    }

    #[test]
    fn port_in_use_fails_and_holds_dependents() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (prog, args) = sleeper();
        let cfg = config(
            vec![
                service("a", prog, &args, Some(port), &[]),
                service("b", prog, &args, None, &["a"]),
            ],
            "port",
        );
        let sup = Supervisor::new(&cfg, Box::new(|_| {}));
        sup.start_all();
        let a = sup.views().into_iter().find(|v| v.id == "a").unwrap();
        assert_eq!(a.state, State::Failed);
        assert_eq!(a.reason, Some(Reason::PortInUse { port }));
        for _ in 0..4 {
            sup.tick();
        }
        assert_eq!(state_of(&sup, "b"), State::Waiting);
        sup.stop_all();
        drop(listener);
    }

    #[test]
    fn exited_process_fails_and_missing_program_is_not_configured() {
        let cfg = config(
            vec![
                service(
                    "a",
                    if cfg!(windows) { "cmd" } else { "false" },
                    if cfg!(windows) {
                        &["/C", "exit 3"][..]
                    } else {
                        &[][..]
                    },
                    None,
                    &[],
                ),
                service("b", "", &[], None, &[]),
            ],
            "exit",
        );
        let sup = Supervisor::new(&cfg, Box::new(|_| {}));
        sup.start("a").unwrap();
        wait_for(&sup, "a", State::Failed);
        let a = sup.views().into_iter().find(|v| v.id == "a").unwrap();
        assert!(matches!(a.reason, Some(Reason::Exited { .. })));
        sup.start("b").unwrap();
        let b = sup.views().into_iter().find(|v| v.id == "b").unwrap();
        assert_eq!(
            (b.state, b.reason),
            (State::Failed, Some(Reason::NotConfigured))
        );
    }

    #[test]
    fn switch_marks_from_and_starts_to() {
        let (prog, args) = sleeper();
        let mut sub = service("b", prog, &args, None, &[]);
        sub.standby = true;
        let cfg = config(vec![service("a", prog, &args, None, &[]), sub], "switch");
        let sup = Supervisor::new(&cfg, Box::new(|_| {}));
        assert_eq!(state_of(&sup, "b"), State::Standby);
        sup.start("a").unwrap();
        wait_for(&sup, "a", State::Running);
        sup.switch(
            "a",
            "b",
            State::Down,
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .unwrap();
        assert_eq!(state_of(&sup, "a"), State::Down);
        wait_for(&sup, "b", State::Running);
        sup.stop_all();
        assert_eq!(state_of(&sup, "b"), State::Standby);
    }

    #[test]
    fn formats_jst() {
        // 2026-11-21 00:00:00 UTC = 09:00 JST
        assert_eq!(jst_string(1_795_219_200_000), "2026-11-21 09:00:00");
    }
}
