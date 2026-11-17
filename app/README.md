# Tokamak app

The client is Solid 2 and TanStack Router in a Tauri 2 window, with no SSR.
The plain host lists Chat threads and compiler-built plugin views. Chat's old
`src/client` remains excluded; the host calls Chat's server API directly.

Install proto, Rust and the platform Tauri prerequisites, then from the root:

```sh
proto run bun -- install --frozen-lockfile
proto run bun -- run app
```

The Tauri hooks build Chat and the server. The host starts or reuses the server
and connects automatically. Retry repeats endpoint discovery. Closing the window
leaves the server running; `proto run bun -- run server:stop` stops it.
`TOKAMAK_SERVER_DIR` selects a separate store/discovery directory. Development
uses workspace plugins; release uses Resources/plugins. `TOKAMAK_PLUGIN_DIR`
overrides the installation for disposable integration runs. Stop the server
before changing installations. Discovery and the private token normally live in
`~/Library/Application Support/com.pixelscortex.Tokamak` on macOS.

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
and the app adds it to the WebSocket URL. The server allows the Tauri origins
and port 1420 by default; other origins require `TOKAMAK_ALLOWED_ORIGINS`.

## Shell integration

`src/plugins/views.tsx` exports `createPluginShell(client, endpoint, source,
routing)` and `PluginViews({ shell, view })`. The shell exposes `views()` with
`{ id, plugin, route, title, generation }` for a sidebar and `navigation.navigate`
for selecting one. `PluginViews` draws a stage with a plugin error boundary.
Routes under `/p/<plugin>` are also installed in TanStack's root automatically.
The current `App` owns connection, plugin shell and disposal; `router.tsx` owns
the router and outlet. Keep one shell per connection. Shared host module exports,
SDK contexts, router and shortcuts are provided through the static import map.
See [src/plugins/README.md](src/plugins/README.md) for loader lifetime details.

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
the actual server binary and plugin resources before launching or bundling.
Release builds package the server as an external binary. No signing is required
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
`tests/fixtures/integration/src/client/api.tsx`, then in a second terminal:

```sh
TOKAMAK_SERVER_DIR="$PWD/app/.dev/integration/desktop" proto run bun -- app/scripts/integration-fixture.ts --reload
```

The rebuild installs the complete artifact, then explicitly asks the running
server to reload it. The selected view changes revision without restarting the
window or server. There is no file watcher. Restore the source afterward.
For browser verification against that same private server, stop Tauri dev
(Ctrl+C; the server stays running), then:

```sh
TOKAMAK_SERVER_DIR="$PWD/app/.dev/integration/desktop" proto run bun -- app/scripts/integration-browser.ts
```

Open port 1420, repeat thread creation and fixture selection, then repeat the
rebuild/reload command above. This helper reads the disposable discovery and
token into Vite's development environment without printing the capability.

Verified locally on macOS arm64 with the unsigned release app and its release
sidecar: Chat threads loaded; FixtureView rendered; creating a thread updated
both host and fixture queries; rebuild/install plus explicit reload swapped the
selected revision without restarting. Vite against the same private server also
passed, including authenticated stylesheet loading and preservation of the
browser document across reload. Screenshot and accessibility captures are kept
locally under `app/.dev/integration/proof`. Windows/Linux were not exercised.
