#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;

fn main() {
    tauri::Builder::default()
        .manage(server::Host::default())
        .invoke_handler(tauri::generate_handler![server::tokamak_endpoint])
        .run(tauri::generate_context!())
        .expect("Tauri application failed");
}
