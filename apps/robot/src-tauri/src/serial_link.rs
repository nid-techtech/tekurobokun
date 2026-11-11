use std::io::Write;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serialport::SerialPort;

const BAUD_RATE: u32 = 115_200;
const WRITE_TIMEOUT: Duration = Duration::from_millis(100);
// 仕様4.3節の既定値。config.default.jsonのdrive.keepAliveIntervalMsと値を一致させること。
const KEEPALIVE_INTERVAL_MS: u64 = 80;

#[derive(Clone, Copy, PartialEq)]
struct MotorCommand {
    l: i32,
    r: i32,
}

pub struct SerialLinkState {
    port: Mutex<Option<Box<dyn SerialPort>>>,
    last_command: Mutex<MotorCommand>,
}

impl Default for SerialLinkState {
    fn default() -> Self {
        Self {
            port: Mutex::new(None),
            last_command: Mutex::new(MotorCommand { l: 0, r: 0 }),
        }
    }
}

impl SerialLinkState {
    fn write_command(&self, command: MotorCommand) -> Result<(), String> {
        let mut guard = self.port.lock().map_err(|e| e.to_string())?;
        let port = guard
            .as_mut()
            .ok_or_else(|| "シリアルポートが接続されていません".to_string())?;
        let line = format!("{},{}\n", command.l, command.r);
        port.write_all(line.as_bytes())
            .map_err(|e| format!("コマンド送信に失敗しました: {e}"))
    }
}

// 状態がSTOP以外の間、config経由の周期でハートビートを送信し続ける（仕様4.3節）。
// 接続前・切断中は送信に失敗するが、スレッド自体は停止せず次周期に備える。
pub fn spawn_keepalive_task(state: Arc<SerialLinkState>) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(KEEPALIVE_INTERVAL_MS));
        let command = match state.last_command.lock() {
            Ok(guard) => *guard,
            Err(_) => continue,
        };
        match state.write_command(command) {
            Ok(()) => println!("[keepalive] sent {},{}", command.l, command.r),
            Err(_) => println!(
                "[keepalive] tick {},{} (ポート未接続のため送信スキップ)",
                command.l, command.r
            ),
        }
    });
}

#[tauri::command]
pub fn serial_list_ports() -> Result<Vec<String>, String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|p| p.port_name).collect())
        .map_err(|e| e.to_string())
}

// port_name未指定時は、利用可能なポートのうち最初の1つに接続を試みる。
#[tauri::command]
pub fn serial_connect(
    state: tauri::State<Arc<SerialLinkState>>,
    port_name: Option<String>,
) -> Result<String, String> {
    let resolved_port_name = match port_name {
        Some(name) => name,
        None => {
            let ports = serialport::available_ports().map_err(|e| e.to_string())?;
            ports
                .first()
                .map(|p| p.port_name.clone())
                .ok_or_else(|| "利用可能なシリアルポートが見つかりません".to_string())?
        }
    };

    let port = serialport::new(&resolved_port_name, BAUD_RATE)
        .timeout(WRITE_TIMEOUT)
        .open()
        .map_err(|e| format!("ポート {resolved_port_name} への接続に失敗しました: {e}"))?;

    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    *guard = Some(port);

    Ok(resolved_port_name)
}

// フロント（DriveStateMachine.onStateChange）はこのコマンドを呼ぶだけでよい。
// 送信タイミングのスケジューリング（即時送信・ハートビート継続）はこの層が担う。
#[tauri::command]
pub fn serial_set_command(
    state: tauri::State<Arc<SerialLinkState>>,
    l: i32,
    r: i32,
) -> Result<(), String> {
    if !(-100..=100).contains(&l) || !(-100..=100).contains(&r) {
        return Err(format!(
            "モーターコマンドは-100〜100の範囲で指定してください (l={l}, r={r})"
        ));
    }

    let new_command = MotorCommand { l, r };
    let changed = {
        let mut guard = state.last_command.lock().map_err(|e| e.to_string())?;
        let changed = *guard != new_command;
        *guard = new_command;
        changed
    };

    if changed {
        // 変化時のみ即時送信する。変化がなければキープアライブスレッドの周期送信に委ねる。
        println!("[serial_set_command] state changed -> immediate send {l},{r}");
        state.write_command(new_command)?;
    }

    Ok(())
}
