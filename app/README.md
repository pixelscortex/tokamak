# Tokamak app

The client is Solid 2 and TanStack Router in a Tauri 2 window, with no SSR.
The shell is the frame; everything inside it comes from plugin views.

Install proto, Rust and the platform Tauri prerequisites, then from the root:

```sh
proto run bun -- install --frozen-lockfile
proto run bun -- run app
```

The Tauri hooks build the starter set and the [Runner](../packages/runner/README.md),
plus the plugin host on macOS and Linux. The app starts one Runner and the window
connects to it automatically. The app restarts the Runner if it exits; the
window shows its existing disconnected state and Retry connects to the new port.
`TOKAMAK_SERVER_DIR` still selects the store directory. Development uses the
workspace plugins; release uses Resources/plugins. `TOKAMAK_PLUGIN_DIR` overrides
the installation. Runner startup errors go to `runner.log` beside the store.
On start the app's Runner stops any Tokamak server that holds this store,
after verifying it: one left by a previous desktop version, or one started with
`server:start` on the same `TOKAMAK_SERVER_DIR`. If another Runner owns the store, the app reports the conflict; close
the other process before relaunching this app.

## When the app quits

The local server used to keep running after the window closed; quitting the app
now stops the Runner and its plugins and programs, and keeping the Runner alive
is planned for later.

For browser development, use two terminals:

```sh
proto run bun -- run server:start
proto run bun -- run --cwd app dev
```

Open `http://127.0.0.1:1420`. The helper builds Chat and serves a disposable store
on port 43123, removed on exit. `VITE_TOKAMAK_HTTP` changes the browser endpoint; `VITE_TOKAMAK_TOKEN` supplies
a capability for a private local server (development only).
No external agent runs. Desktop `tokamak_endpoint` returns `{ http, ws, token }`;
the adapter adds the token to server module, stylesheet and catalog requests,
and the app sends it as a WebSocket subprotocol. The server allows the Tauri origins
and port 1420 by default; other origins require `TOKAMAK_ALLOWED_ORIGINS`.

## Shell

`src/shell/` is the frame: a top strip (sidebar toggle, search, back and forward,
one tab per open route), the rail of plugin views with settings at its foot, the
sidebar, the stage with its page header and footer, and an optional right panel.
`shell.tsx` owns the connection (`session.ts`), the theme, the tabs
(`navigation.ts`) and the window's keys; `frame.tsx` lays them out. A plugin view
fills the sidebar, header and panel with `Region.Sidebar`, `Region.Header` and
`Region.Panel` from `@tokamak/sdk/client`; empty regions are hidden, and an empty
header shows the page title a view set with `usePageTitle`, else the view's
title. Tabs keep the page title they last had; a view's optional `icon` marks
it in the rail, tabs and search (the first letter otherwise). The rail can be
turned off in `shell/config.ts`.

Keys go through the SDK `Shortcuts` facade (`ShortcutContext`): ⌘B sidebar, ⌘K
search, ⌘[ and ⌘] back and forward, ⌃Tab and ⌃⇧Tab next and previous tab (Ctrl
instead of ⌘ off macOS). `/kit` opens full-bleed from the settings menu.

Quitting (`src-tauri/src/quit.rs`, `src/host/quit.ts`, `src/shell/quit.tsx`):
the Quit menu item (ours replaces the platform's, which on macOS cannot be
delayed), Cmd+Q, closing the window and other exit requests are held and sent
to the window on the channel it registers with `quit_listen`. The window asks
plugins (`quitBlockers`); with nothing running it answers `quit_confirm` at
once, else it shows the dialog and answers `quit_hold`, then `quit_cancel` or
(after Stop and quit) `quit_confirm`. No answer within 3 seconds quits anyway.
`quit_confirm` stops the Runner and its local workers and programs,
then exits. The main window runs with WebKit's background throttling off
(`tauri.conf.json`), so a hidden or minimized window still relays its local
part's sign of life and answers a quit.

`src/plugins/views.tsx` still exports `createPluginShell` and `PluginViews`; the
frame reads `views()` for the rail, tabs and search. See
[src/plugins/README.md](src/plugins/README.md) for loader lifetime details.

## Checks and builds

From the root:

```sh
proto run bun -- run check
proto run bun -- run typecheck
cargo check --workspace --all-targets --locked
cargo test --workspace --locked
proto run bun -- run moon run sdk:test build:test
proto run bun -- run --cwd app test
proto run bun -- run --cwd app build
proto run bun -- run --cwd app tauri build --no-sign
```

Plugin typechecking first generates Chat's server API with the SDK bundler.
Direct Cargo checks do not require bundled sidecars or plugin resources: the
Tauri build script omits absent packaging inputs. Tauri dev/build hooks prepare
the actual Runner binary and plugin resources before launching or bundling.
Release builds package the Runner as an external binary. No signing is required
for this local build. The CSP permits loopback HTTP/styles and WebSockets, blob
modules and a hashed import map, with no eval. Keep the Vite Solid runtime alias:
mixing development and production runtimes can produce a blank window.

## Disposable end-to-end fixture

Build/install Chat and the UI fixture, then launch the desktop app:

```sh
proto run bun -- app/scripts/integration-fixture.ts
TOKAMAK_SERVER_DIR="$PWD/app/.dev/integration/desktop" TOKAMAK_PLUGIN_DIR="$PWD/app/.dev/integration/plugins" proto run bun -- run app
```

In the window, check the live thread count and select `FixtureView` in Plugin
views. Its `useQuery` uses the same Chat thread API. Create a thread and confirm
both counts update. Change `Fixture revision one` in
`app/tests/fixtures/integration/src/client/api.tsx`, then in a second terminal:

```sh
TOKAMAK_SERVER_DIR="$PWD/app/.dev/integration/desktop" proto run bun -- app/scripts/integration-fixture.ts --reload
```

The rebuild installs the complete artifact, then explicitly asks the running
server to reload it. The selected view changes revision without restarting the
window or server. There is no file watcher. Restore the source afterward.
For browser verification, start a separate disposable Runner, with its own
store and the same plugin builds:

```sh
TOKAMAK_SERVER_DIR="$PWD/app/.dev/integration/browser" proto run bun -- app/scripts/integration-browser.ts
```

Open port 1420, repeat thread creation and fixture selection, then run the same
rebuild/reload command with `TOKAMAK_SERVER_DIR` pointing at the browser store.
The helper checks the fixture through the CLI and gives Vite only the secret
for the Runner it starts. The desktop Runner's `runner.control` credential
allows plugin list and reload; it cannot connect a browser to that workspace.
