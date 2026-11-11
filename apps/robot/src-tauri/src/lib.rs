// 走行はこの版では使わないため、シリアル通信（モーターへのコマンド送信）は配線しない。
// コードは今後の版のために残す。
#[allow(dead_code)]
mod serial_link;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
