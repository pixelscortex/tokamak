#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod quit;
mod runner;

use tauri::{Manager, RunEvent, WindowEvent};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            runner::start(app.handle());
            Ok(())
        })
        .manage(quit::Quit::default())
        .menu(quit::menu)
        .on_menu_event(|app, event| {
            if event.id() == quit::MENU_ID {
                quit::request(app);
            }
        })
        .on_window_event(|window, event| {
            // Closing the window quits the app: ask first, like the Quit item.
            if let WindowEvent::CloseRequested { api, .. } = event
                && !window.state::<quit::Quit>().finished()
            {
                api.prevent_close();
                quit::request(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            runner::tokamak_endpoint,
            quit::quit_listen,
            quit::quit_hold,
            quit::quit_cancel,
            quit::quit_confirm
        ])
        .build(tauri::generate_context!())
        .expect("Tauri application failed")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, .. } = event
                && !app.state::<quit::Quit>().finished()
            {
                api.prevent_exit();
                quit::request(app);
            }
        });
}
