# Tokamak app

`@tokamak/app` is a client-rendered Solid 2 web app in a Tauri 2 window.
TanStack Router defines `/` for live Chat threads and `/kit` for ui-sdk controls.
There is no plugin UI loader or product shell yet.

From the repository root, install the pinned tools and dependencies:

```sh
proto run bun -- install --frozen-lockfile
```

Use two terminals. The first command builds Chat's server artifact and the
existing server binary, then starts a loopback server with a fresh disposable
store. Ctrl+C stops the server and removes its store.

```sh
proto run bun -- run server:start
proto run bun -- run app
```

The app connects to `ws://127.0.0.1:43123/ws` when Connect is pressed.
New thread creates a thread and the subscription updates the list.
`moon run app:dev` runs Vite alone at `http://127.0.0.1:1420`.
The server helper installs only Chat; no external agent runs.

After building the server and Chat, the helpers can also run directly:

```sh
proto run bun -- app/scripts/server.ts
proto run bun -- app/scripts/live-check.ts
```

Checks and unsigned local builds:

```sh
moon run app:check app:test app:web-build
proto run bun -- run --cwd app tauri build --no-sign
```

The Tauri crate belongs to the root Cargo workspace and uses its lockfile.
The host has an overlay title bar, native traffic lights, and one capability
for dragging the main window. The CSP disallows eval. Server startup and
packaging inside Tauri remain for the host agent. Desktop release CI is pending.

Vite selects the matching Solid development or production runtime for each mode.
Keep that selection when changing the build: mixed runtimes render a blank window.

Root dependency overrides pin Solid and its DOM runtime to 2.0.0, including
the Router RC’s transitive packages that still declare Solid 1 peer ranges.
The app tests cover the installed RC; its unused legacy devtools are not enabled.
