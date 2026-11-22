import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Quitting the desktop app (app/src-tauri/src/quit.rs). The native side holds
 * every quit (menu, Cmd+Q, closing the window) and tells the window, which
 * decides: `confirmQuit` closes the app, `holdQuit` says a dialog is asking
 * the person, `cancelQuit` keeps the app open. A window that answers nothing
 * within a few seconds is quit anyway, so a stuck page cannot block quitting.
 */
export function listenForQuit(requested: () => void): void {
  if (!isTauri()) return;
  const events = new Channel<{ type: "quit" }>();
  events.onmessage = (event) => {
    if (event.type === "quit") requested();
  };
  void invoke("quit_listen", { events });
}

export const confirmQuit = () => invoke("quit_confirm");
export const holdQuit = () => invoke("quit_hold");
export const cancelQuit = () => invoke("quit_cancel");
