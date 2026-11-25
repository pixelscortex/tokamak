//! Quitting with work in progress. Every way out (the Quit menu item and its
//! Cmd+Q, closing the window, the OS asking the app to exit) is held here and
//! handed to the window, which asks plugins whether anything still runs on
//! this computer (`onQuit` in the SDK) and shows "Claude is still working in 1
//! thread · Stop and quit · Cancel" when it does. On the way out every local
//! worker is closed by the Runner, and each agent program dies with its worker.
//!
//! The window must keep running while hidden or minimized for this (and for
//! the turns' sign of life): tauri.conf.json turns WebKit's background
//! throttling off for the main window.
use serde_json::{Value, json};
use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{Manager, ipc::Channel};

/// A window that neither confirms nor holds a quit within this long is quit
/// anyway: a stuck page must not keep the app open.
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(3);

/// The id of the Quit menu item that replaces the platform's own (see `menu`).
pub const MENU_ID: &str = "tokamak-quit";

/// Where a quit stands. The commands below are thin wrappers over these methods.
#[derive(Default)]
pub struct Quit {
    window: Mutex<Option<Channel<Value>>>,
    /// The person (or a window with nothing running) has agreed: let the exit through.
    confirmed: AtomicBool,
    finished: AtomicBool,
    /// Counts quit requests, so a late timer from an earlier one does nothing.
    asked: AtomicU64,
    /// The window answered the latest request (holding it for a dialog, or cancelling).
    answered: AtomicU64,
}

/// What to do with a quit.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Let it through: confirmed, or no window to ask.
    Exit,
    /// Hold it and ask the window.
    Ask,
}

impl Quit {
    /// The window listens for quit requests on `events`.
    pub fn listen(&self, events: Channel<Value>) {
        *lock(&self.window) = Some(events);
    }

    pub fn decide(&self) -> Decision {
        if self.confirmed.load(Ordering::SeqCst) || lock(&self.window).is_none() {
            Decision::Exit
        } else {
            Decision::Ask
        }
    }

    /// Tells the window about a new quit; returns the request's number, or
    /// None when the window cannot be told (then the app quits).
    pub fn ask(&self) -> Option<u64> {
        let request = self.asked.fetch_add(1, Ordering::SeqCst) + 1;
        let window = lock(&self.window);
        let sent = window.as_ref()?.send(json!({ "type": "quit" }));
        sent.is_ok().then_some(request)
    }

    /// The window answered the latest request: it holds the quit for a dialog, or the person cancelled.
    pub fn answer(&self) {
        self.answered
            .store(self.asked.load(Ordering::SeqCst), Ordering::SeqCst);
    }

    /// Whether `request` is still the latest and the window never answered it.
    pub fn unanswered(&self, request: u64) -> bool {
        self.asked.load(Ordering::SeqCst) == request
            && self.answered.load(Ordering::SeqCst) < request
    }

    /// From now on every exit goes through.
    pub fn confirm(&self) -> bool {
        !self.confirmed.swap(true, Ordering::SeqCst)
    }

    /// Only release the platform exit after the Runner has shut down.
    pub fn finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }
}

/// A poisoned lock still holds the channel; quitting must not panic over it.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Holds this quit and asks the window; exits if the window cannot be told or does not answer.
pub fn request(app: &tauri::AppHandle) {
    let quit = app.state::<Quit>();
    if quit.decide() == Decision::Exit {
        return exit(app.clone());
    }
    let Some(request) = quit.ask() else {
        return exit(app.clone());
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ANSWER_TIMEOUT).await;
        if app.state::<Quit>().unanswered(request) {
            exit(app.clone());
        }
    });
}

/// Stops the Runner before allowing the platform exit.
fn exit(app: tauri::AppHandle) {
    if !app.state::<Quit>().confirm() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        crate::runner::shutdown(&app).await;
        app.state::<Quit>().finished.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

/// The window listens for quit requests on `events`.
#[tauri::command]
pub fn quit_listen(quit: tauri::State<'_, Quit>, events: Channel<Value>) {
    quit.listen(events);
}

/// The window is asking the person; the quit waits for them.
#[tauri::command]
pub fn quit_hold(quit: tauri::State<'_, Quit>) {
    quit.answer();
}

/// The person chose Cancel: the app stays open.
#[tauri::command]
pub fn quit_cancel(quit: tauri::State<'_, Quit>) {
    quit.answer();
}

/// Nothing runs any more (or the person chose Stop and quit): quit now.
#[tauri::command]
pub fn quit_confirm(app: tauri::AppHandle) {
    exit(app);
}

/// The platform's menu with its Quit item replaced by one of ours (same name
/// and Cmd+Q / Ctrl+Q). The platform's item ends the app at once on macOS,
/// without a chance to ask; ours goes through `request`.
pub fn menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
    let menu = Menu::default(app)?;
    // Tauri's own name for its Quit item ("Quit Tokamak"), so ours reads the same.
    let quit_text = PredefinedMenuItem::quit(app, None)?.text()?;
    for item in menu.items()? {
        let MenuItemKind::Submenu(submenu) = item else {
            continue;
        };
        for (position, entry) in submenu.items()?.into_iter().enumerate() {
            let MenuItemKind::Predefined(predefined) = entry else {
                continue;
            };
            if predefined.text()? != quit_text {
                continue;
            }
            submenu.remove(&predefined)?;
            let ours = MenuItem::with_id(app, MENU_ID, &quit_text, true, Some("CmdOrCtrl+Q"))?;
            submenu.insert(&ours, position)?;
        }
    }
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(sent: std::sync::Arc<AtomicU64>) -> Channel<Value> {
        Channel::new(move |_| {
            sent.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }

    #[test]
    fn a_quit_is_held_only_while_a_window_listens_and_nothing_confirmed_it() {
        let quit = Quit::default();
        assert_eq!(quit.decide(), Decision::Exit, "no window to ask");
        assert_eq!(quit.ask(), None, "nobody to tell: the app quits");
        quit.listen(window(Default::default()));
        assert_eq!(quit.decide(), Decision::Ask);
        quit.confirm();
        assert_eq!(quit.decide(), Decision::Exit, "confirmed");
    }

    #[test]
    fn the_window_is_told_and_only_an_unanswered_latest_request_times_out() {
        let quit = Quit::default();
        let sent = std::sync::Arc::new(AtomicU64::new(0));
        quit.listen(window(sent.clone()));
        let first = quit.ask().unwrap();
        assert_eq!(sent.load(Ordering::SeqCst), 1);
        assert!(quit.unanswered(first));
        quit.answer();
        assert!(!quit.unanswered(first), "held for a dialog");
        let second = quit.ask().unwrap();
        assert!(quit.unanswered(second), "a new quit needs a new answer");
        assert!(
            !quit.unanswered(first),
            "an old request's timer does nothing"
        );
    }

    #[test]
    fn the_main_window_keeps_running_while_hidden() {
        // Beats from the local part and the quit answer go through the window:
        // WebKit must not throttle or suspend it when hidden or minimized.
        let config: tauri::utils::config::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = &config.app.windows[0];
        assert_eq!(
            main.background_throttling,
            Some(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        );
    }
}
