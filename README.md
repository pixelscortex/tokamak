# Tokamak

Tokamak is a Rust server with TypeScript plugins and a Solid 2 web client in
Tauri 2. The client skeleton lists and creates Chat threads. `/kit` holds
ui-sdk controls. Compiler-built plugin views load through the server; the product shell is next.

On a shared server, caller actions use the matching plugin builds already installed on
each member's computer. Milestone 1 does not download those builds from the server.
Only the creator can rename or delete a thread or run its agent. Other members can post text.

Agents use the sign-in on the member's computer. The client passes through
`SSH_AUTH_SOCK` and `SSH_AGENT_PID` when present, so the agent can use the member's
SSH agent for commands such as `git push`. The Mac app requires macOS 14 or later.

## Run

Install proto, rustup, and your platform's Tauri prerequisites. `.prototools`
pins Bun, Moon, and Rust. From this repository:

```sh
proto run bun -- install --frozen-lockfile
```

Launch the desktop app:

```sh
proto run bun -- run app
```

The app builds the starter set, starts the Runner, and connects automatically.
New thread creates a Chat thread. No external agent is started. See [app/README.md](app/README.md) for browser development and checks.

## Packages

`packages/server` owns storage and plugin execution. `packages/engine` keeps
QuickJS for server plugins. `packages/runtime` keeps a server-only Rust facade,
server process tooling, and reusable TypeScript catalog/reload logic.
`packages/sdk` supplies the portable protocol and Solid 2 DOM integrations.
`packages/build` builds server plugin artifacts. `packages/ui` is a placeholder
for web primitives and tokens. `wiki` contains the docs and design rules.

Chat's `plugins/chat/src/client` stays untouched as rewrite reference. Its root
tsconfig includes only `plugin.ts` and `src/server`; lint ignores the client.
The compiler emits DOM ESM plugin UI and the web host loads it through
revision-pinned server URLs. Chat's client remains excluded until ported.
No Solid 1 runtime remains in workspace dependencies.

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
Server/engine tests and SDK/build/app tests cover the runtime. Run
`proto run bun -- x playwright install --no-shell chromium webkit` once, then
`proto run bun -- run e2e:browser` for production browser tests against a real
disposable server. See [e2e/README.md](e2e/README.md) for adding tests.

Ready pull requests run the Linux TypeScript, Rust, and lint checks. The Rust
check runs the local suites on the Runner and the server suites against the
actions-only cloud build. Both use QuickJS.
Desktop builds are manual. `bash .ci/release-macos.sh` on macOS arm64 creates the unsigned `.app`, zip
and standalone server archive under `.ci-results/macos-arm64`. The release
workflow is manual and uploads artifacts only. See [.ci/README.md](.ci/README.md)
for reserved signing inputs; signing, notarization and publishing are absent.

## Build for a machine or the cloud

Build the **Runner** for the desktop app, real machines and sandboxes. On macOS
and Linux, ship the full `tokamak-plugin-host` beside it. Do not run the Runner
in Docker for deployment. On Windows, build only `tokamak-runner`.
Caller actions and server actions are unavailable on Windows.

```sh
cargo build --locked --release -p tokamak-runner -p tokamak-plugin-host
```

Build the **Server** for cloud hosts such as Railway or Hetzner. Plugins have
no filesystem or program access on the Server. The Server itself starts only
one kind of plugin child: the action process. It keeps the process launcher
and guardian needed to run, inspect, and supervise server actions. Build it in
`target/cloud` so it cannot replace the Runner's binaries. The
[Dockerfile](Dockerfile) ships this pair and keeps the existing entrypoint,
environment, ports and data directory.

```sh
cargo build --locked --release --no-default-features -p server -p tokamak-plugin-host --target-dir target/cloud
```

On macOS and Linux, ship the host beside its matching executable, or set
`TOKAMAK_PLUGIN_HOST` to that host's path. Check with
`tokamak-plugin-host --capabilities`: the Runner host prints `actions local`
and the Server host prints `actions`. The Runner checks this at startup.
Bun is a developer tool for building plugins and running tests. Installed
artifacts run without it. Rebuild old artifacts that lack QuickJS companions.
See the [plugin process and action process guide](packages/sdk/README.md#plugin-process-and-action-process)
for supported modules, permissions and limits.
