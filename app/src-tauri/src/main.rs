#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod quit;
mod runner;
mod sign_in_return;

use tauri::{Manager, RunEvent, WindowEvent};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            runner::start(app.handle());
            Ok(())
        })
        .manage(quit::Quit::default())
        .manage(sign_in_return::Returns::default())
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
            runner::reveal_plugins_folder,
            quit::quit_listen,
            quit::quit_hold,
            quit::quit_cancel,
            quit::quit_confirm,
            sign_in_return::sign_in_return_listen,
            sign_in_return::sign_in_return_cancel,
            sign_in_return::sign_in_open_browser
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
