// ランチャー（apps/launcher）のRust側。サービスの起動と監視（ServiceSupervisor）、
// 手元のHTTP（起動の確認・ハートビート・管理用API）、サインイン時の自動起動を受け持つ。
// 画面（TypeScript）とは、コマンドと「services」のイベントでやりとりする。

mod config;
mod http;
mod job;
mod supervisor;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_autostart::ManagerExt;

use config::LauncherConfig;
use supervisor::{ServiceView, State, Supervisor};

/// 管理用APIの呼び出しの時間切れ
const ADMIN_TIMEOUT: Duration = Duration::from_secs(5);

struct AppState {
    supervisor: Arc<Supervisor>,
    config: Option<LauncherConfig>,
    config_path: String,
    config_error: Option<String>,
    started_all_on_launch: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchInfo {
    config: Option<LauncherConfig>,
    config_path: String,
    config_error: Option<String>,
    /// 設定（startAllOnLaunch）で、起動と同時に［すべて起動］を行った
    started_all_on_launch: bool,
    /// サインイン時の自動起動が有効か
    autostart: Option<bool>,
}

/// 重い処理（プロセスの終了を待つ・HTTP）を、画面を止めないよう別のスレッドで行う。
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn launch_info(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> LaunchInfo {
    LaunchInfo {
        config: state.config.clone(),
        config_path: state.config_path.clone(),
        config_error: state.config_error.clone(),
        started_all_on_launch: state.started_all_on_launch,
        autostart: app.autolaunch().is_enabled().ok(),
    }
}

#[tauri::command]
fn list_services(state: tauri::State<'_, AppState>) -> Vec<ServiceView> {
    state.supervisor.views()
}

#[tauri::command]
async fn start_service(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let sup = Arc::clone(&state.supervisor);
    blocking(move || sup.start(&id)).await?
}

#[tauri::command]
async fn stop_service(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let sup = Arc::clone(&state.supervisor);
    blocking(move || sup.stop(&id, None)).await?
}

#[tauri::command]
async fn restart_service(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let sup = Arc::clone(&state.supervisor);
    blocking(move || sup.restart(&id)).await?
}

#[tauri::command]
async fn start_all(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let sup = Arc::clone(&state.supervisor);
    blocking(move || sup.start_all()).await
}

#[tauri::command]
async fn stop_all(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let sup = Arc::clone(&state.supervisor);
    blocking(move || sup.stop_all()).await
}

/// 正→副の切り替え（mark: "down"）と、正に戻す（mark: "standby"）。
#[tauri::command]
async fn switch_service(
    from: String,
    to: String,
    mark: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mark = match mark.as_str() {
        "down" => State::Down,
        "standby" => State::Standby,
        "stopped" => State::Stopped,
        other => return Err(format!("unknown mark: {other}")),
    };
    let (release, settle) = match &state.config {
        Some(c) => (
            Duration::from_millis(c.failover.release_timeout_ms),
            Duration::from_millis(c.failover.settle_ms),
        ),
        None => return Err("no config".into()),
    };
    let sup = Arc::clone(&state.supervisor);
    blocking(move || sup.switch(&from, &to, mark, release, settle)).await?
}

/// GETして200番台ならtrue（ハートビート）。
#[tauri::command]
async fn probe(url: String, timeout_ms: u64) -> Result<bool, String> {
    blocking(move || http::probe(&url, Duration::from_millis(timeout_ms))).await
}

/// backendの管理用API（127.0.0.1）を呼ぶ。pathは/admin/で始まるものだけ。
#[tauri::command]
async fn admin_request(
    method: String,
    path: String,
    body: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<http::HttpResponse, String> {
    if !path.starts_with("/admin/") {
        return Err(format!("not an admin path: {path}"));
    }
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "DELETE") {
        return Err(format!("method not allowed: {method}"));
    }
    let port = state
        .config
        .as_ref()
        .map(|c| c.admin_port)
        .ok_or("no config")?;
    let url = format!("http://127.0.0.1:{port}{path}");
    blocking(move || http::request(&method, &url, body.as_deref(), ADMIN_TIMEOUT)).await?
}

/// サービスの出力のファイルを、既定のアプリで開く。
#[tauri::command]
fn open_log(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let path = state.supervisor.log_path_of(&id)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    open_with_default_app(&path)
}

fn open_with_default_app(path: &Path) -> Result<(), String> {
    let program = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let config_path = config::config_path(&config_dir)
                .to_string_lossy()
                .into_owned();
            let (config, config_error) = match config::load(&config_dir) {
                Ok(c) => (Some(c), None),
                Err(e) => (None, Some(e)),
            };
            let handle = app.handle().clone();
            let empty = LauncherConfig {
                repo_dir: String::new(),
                log_dir: String::new(),
                start_all_on_launch: false,
                autostart: false,
                admin_port: 0,
                search_monthly_limit: 0,
                heartbeat: config::HeartbeatConfig {
                    url: String::new(),
                    interval_ms: 0,
                    timeout_ms: 0,
                    failures: 0,
                },
                failover: config::FailoverConfig {
                    from: String::new(),
                    to: String::new(),
                    release_timeout_ms: 0,
                    settle_ms: 0,
                },
                services: Vec::new(),
            };
            let supervisor = Supervisor::new(
                config.as_ref().unwrap_or(&empty),
                Box::new(move |views| {
                    let _ = handle.emit("services", views);
                }),
            );
            supervisor.spawn_ticker();

            // サインイン時の自動起動を、設定（autostart）に合わせる
            if let Some(c) = &config {
                let autolaunch = app.autolaunch();
                let enabled = autolaunch.is_enabled().unwrap_or(false);
                if c.autostart && !enabled {
                    let _ = autolaunch.enable();
                } else if !c.autostart && enabled {
                    let _ = autolaunch.disable();
                }
            }

            let started_all_on_launch = config.as_ref().is_some_and(|c| c.start_all_on_launch);
            if started_all_on_launch {
                supervisor.start_all();
            }
            app.manage(AppState {
                supervisor,
                config,
                config_path,
                config_error,
                started_all_on_launch,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            launch_info,
            list_services,
            start_service,
            stop_service,
            restart_service,
            start_all,
            stop_all,
            switch_service,
            probe,
            admin_request,
            open_log,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app.try_state::<AppState>() {
                state.supervisor.kill_all();
            }
        }
    });
}
