use tauri::webview::{PermissionKind, PermissionResponse};

// 走行はこの版では使わないため、シリアル通信（モーターへのコマンド送信）は配線しない（Phase 9で配線する）。
// コードは今後の版のために残す。
#[allow(dead_code)]
mod serial_link;

/// WebViewの権限の要求への答え（imple 3節）。
/// カメラ（登録のQRの読み取り）とマイク（音声入力）だけを許可し、ほかはすべて拒否する。
/// 許可の確認のダイアログを出さないため、展示中に操作が止まらない。
fn permission_response(kind: PermissionKind) -> PermissionResponse {
    match kind {
        PermissionKind::Camera | PermissionKind::Microphone => PermissionResponse::Allow,
        _ => PermissionResponse::Deny,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .on_permission_request(|_, kind| permission_response(kind))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_camera_and_microphone() {
        assert_eq!(permission_response(PermissionKind::Camera), PermissionResponse::Allow);
        assert_eq!(permission_response(PermissionKind::Microphone), PermissionResponse::Allow);
        for kind in [
            PermissionKind::Geolocation,
            PermissionKind::Notifications,
            PermissionKind::ClipboardRead,
            PermissionKind::DisplayCapture,
            PermissionKind::FileSystemAccess,
            PermissionKind::Other,
        ] {
            assert_eq!(permission_response(kind), PermissionResponse::Deny, "{kind}");
        }
    }
}
