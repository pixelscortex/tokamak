# Tokamak app

`@tokamak/app` is a client-rendered Solid 2 web app in a Tauri 2 window.
TanStack Router defines `/` for live Chat threads and `/kit` for ui-sdk controls.
There is no plugin UI loader or product shell yet.

From the repository root, install the pinned tools and dependencies:

```sh
proto run bun -- install --frozen-lockfile
```

Launch the desktop app with one command:

```sh
proto run bun -- run app
```

Tauri builds Chat and the server, then starts or reuses an independent local
server. The window connects automatically; Retry repeats discovery after an error.
Closing the window leaves the server running. `server:stop` stops it explicitly.
The server chooses a free loopback port and publishes authenticated discovery in
its existing platform data directory (`~/Library/Application Support/com.pixelscortex.Tokamak`
on macOS). `TOKAMAK_SERVER_DIR` overrides it. Existing `store`, `server.token`
and discovery files are reused. Development plugins come from workspace `plugins`;
release plugins come from the app's Resources/plugins. A running server using a
different plugin installation must be stopped before switching installations.

For browser-only development, keep the disposable server helper in one terminal:

```sh
proto run bun -- run server:start
moon run app:dev
```

Browser connections default to `http://127.0.0.1:43123`; set
`VITE_TOKAMAK_HTTP` to override it. The browser helper installs only Chat and
removes its disposable store on exit. No external agent runs.

The Tauri command `tokamak_endpoint` returns `{ http, ws, token }`. The client
adds the private capability as the WebSocket `token` query parameter. A browser
endpoint has `token: null`. Server origin and query-token support is required
for authenticated desktop connections.

Checks and unsigned local builds:

```sh
moon run app:check app:test app:web-build
proto run bun -- run --cwd app tauri build --no-sign
```

The Tauri crate belongs to the root Cargo workspace and uses its lockfile.
The host has an overlay title bar, native traffic lights, and one capability
for dragging the main window. The CSP disallows eval and permits loopback plugin modules and connections.
The build hook packages the server as an external binary and built plugin
installations as resources. Rust launches only that binary; no webview shell
capability is exposed. Desktop release CI is pending.

Vite selects the matching Solid development or production runtime for each mode.
Keep that selection when changing the build: mixed runtimes render a blank window.

Root dependency overrides pin Solid and its DOM runtime to 2.0.0, including
the Router RC’s transitive packages that still declare Solid 1 peer ranges.
The app tests cover the installed RC; its unused legacy devtools are not enabled.
