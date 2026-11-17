# Tokamak

Tokamak is a Rust server with TypeScript plugins and a Solid 2 web client in
Tauri 2. The client skeleton lists and creates Chat threads. `/kit` holds
ui-sdk controls. Plugin UI loading and the product shell are next.

## Run

Install proto, rustup, and your platform's Tauri prerequisites. `.prototools`
pins Bun, Moon, and Rust. From this repository:

```sh
proto run bun -- install --frozen-lockfile
```

Use two terminals:

```sh
proto run bun -- run server:start
proto run bun -- run app
```

The server command builds Chat and the existing server binary, then starts a
loopback server with a disposable store. Ctrl+C stops it and removes the store.
Press Connect in the app, then New thread. No external agent is started.
`moon run app:dev` runs Vite alone. See [app/README.md](app/README.md).

## Packages

`packages/server` owns storage and plugin execution. `packages/engine` keeps
QuickJS for server plugins. `packages/runtime` keeps a server-only Rust facade,
server process tooling, and reusable TypeScript catalog/reload logic.
`packages/sdk` supplies the portable protocol and Solid 2 DOM integrations.
`packages/build` builds server plugin artifacts. `packages/ui` is a placeholder
for web primitives and tokens. `wiki` contains the docs and design rules.

Chat's `plugins/chat/src/client` stays untouched as rewrite reference. Its root
tsconfig includes only `plugin.ts` and `src/server`; lint ignores the client.
`PLUGIN_UI_BUILD_ENABLED` in `packages/build/src/vite.ts` is false, so no plugin
client is checked or bundled and manifests omit `entries.ui`. The rewrite agent
must restore DOM client inputs and lint coverage, then enable the implemented
web build target. No Solid 1 runtime remains in workspace dependencies.

## Checks

```sh
proto run bun -- run check
proto run bun -- run typecheck
proto run bun -- run test
proto run bun -- run e2e
moon run app:web-build
proto run bun -- run --cwd app tauri build --no-sign
```

The check pipeline runs Oxfmt, rustfmt, Oxlint, and advisory Clippy.
Type-checking covers the remaining packages, including the wiki.
Server/engine Rust tests and the server-only E2E suite remain. SDK DOM tests
cover subscriptions and extensions; app tests cover controls and routes.
`tests/compiler-selection.py` remains an opt-in pinned-compiler regression.

Linux CI installs Tauri system libraries. Native validation runs on main;
macOS PR validation uses the `ci:macos` label. Manual release workflows retain
server archives and checksum coordination. Tauri desktop release packaging is
pending. No desktop release archive is built by CI.

## Plugin workers

A plugin opts its actions into Bun with `runtime: "worker"` in `definePlugin`.
Queries and mutations continue to run in QuickJS. Each opted-in plugin has one
lazy, long-lived worker, preserving module state between actions. Bun must be
installed on the machine; a missing executable produces
`Plugin <id> needs Bun: install from https://bun.sh`.

The build emits a separate Bun action bundle and a generic SDK worker entry.
The server and worker exchange newline-delimited JSON with a 1 MiB message cap:
server → worker: `invoke {id, fn, args}`, `opResult {id, value|error}`,
`cancel {id}`, and `shutdown`; worker → server: `result {id, value|error}`,
`op {id, call, name, payload}`, and `log {level, text}`. Messages have a `type`
field. Invocation and operation IDs correlate concurrent calls. Host operations
reuse the existing action bridge and permission checks; workers get no database
handle. Each invocation receives an AbortSignal through `ctx.signal`.

Workers run in per-plugin data folders under the server data directory, with a
cleared environment containing PATH, HOME, USER, LANG and manifest `env:<name>`
grants. Worker code has ordinary local process access; this is not an OS sandbox.
Reload, disable, and server shutdown kill the worker's whole process group.
Crashes fail pending actions and restart on the next call with a short backoff.
Actions have a one-hour wall deadline; cancellation allows 500 ms to settle
before the worker and its children are killed. Plugins without the field keep
running actions in QuickJS.
