// リリースビルドで、余分なコンソールのウィンドウを出さない（消さないこと）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tekurobokun_launcher_lib::run()
}
