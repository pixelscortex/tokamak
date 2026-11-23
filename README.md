# Tokamak

Tokamak is a Rust server with TypeScript plugins and a Solid 2 web client in
Tauri 2. The client skeleton lists and creates Chat threads. `/kit` holds
ui-sdk controls. Compiler-built plugin views load through the server; the product shell is next.

On a shared server, local functions use the matching plugin builds already installed on
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
check builds both variants. It runs the local suites on the QuickJS default and
exercises the Bun fallback, comparing the stored turn replays across runtimes.
Suites that need only server functions run against the cloud Server build.
Desktop builds are manual. `bash .ci/release-macos.sh` on macOS arm64 creates the unsigned `.app`, zip
and standalone server archive under `.ci-results/macos-arm64`. The release
workflow is manual and uploads artifacts only. See [.ci/README.md](.ci/README.md)
for reserved signing inputs; signing, notarization and publishing are absent.

## Build for a machine or the cloud

Build the **Runner** for the desktop app, real machines and sandboxes. On macOS
and Linux, ship the full `tokamak-plugin-host` beside it. Do not run the Runner
in Docker. On Windows, build only `tokamak-runner`; it uses Bun.

```sh
cargo build --locked --release -p tokamak-runner -p tokamak-plugin-host
```

Build the **Server** for cloud hosts such as Railway or Hetzner. The build omits
the local runtime and the Bun fallback. Its `tokamak-plugin-host` only runs and
inspects server actions. Use a separate output directory so it cannot replace
the Runner's full host. The [Dockerfile](Dockerfile) ships this pair and keeps
the existing entrypoint, environment, ports and data directory.

```sh
cargo build --locked --release --no-default-features -p server -p tokamak-plugin-host --target-dir target/cloud
```

On macOS and Linux, ship the host beside its matching executable, or set
`TOKAMAK_PLUGIN_HOST` to that host's path. Bun is needed to build plugins from
source. The QuickJS builds can run installed artifacts without Bun; rebuild old
artifacts that lack QuickJS companions.

For the Runner only, `TOKAMAK_PLUGIN_RUNTIME=bun` selects the temporary Bun
fallback. An empty value is an error on macOS and Linux. Windows ignores the
variable and uses Bun. Run `tokamak-runner --plugin-runtime` to see the selected
runtime. See the [plugin runtime guide](packages/sdk/README.md#plugin-runtimes)
for supported modules, permissions and limits.

## Bun fallback workers

When Bun is selected, each plugin with `runtime: "worker"` has one lazy Bun
worker that preserves module state between actions. For Bun workers, Bun must
be installed on the machine; a missing executable produces
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
running actions in the server’s engine.

With the fallback, the desktop client uses a separate Bun worker for `local` functions.
`client.local(api.module.function, args, { signal })` runs the matching
installed plugin build. Local handlers can use files and start programs
with `ctx.proc`; stopping a program or aborting its invocation stops its
process tree. Local handlers call public server functions through the
window's authenticated session. Only a change to that plugin's local
artifact, or its removal, retires the worker on plugin reload.
