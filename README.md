# Tokamak

A Cargo and Bun workspace for a TypeScript-first application hosted by Rust.
Reusable host, runtime, renderer, SDK and UI packages live under `packages/`.
The single desktop application is composed under `app/`, with Rust and frontend
sources in `app/src/` and SDK backend functions in `app/backend/`.

| Directory           | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `packages/server/`  | Native host crate; builds the `tokamak` executable             |
| `packages/engine/`  | Shared QuickJS engine, budgets and worker pool                 |
| `packages/runtime/` | Feature-gated client/server hosts and local process lifecycle  |
| `packages/render/`  | Native UI renderer crate                                       |
| `packages/sdk/`     | TypeScript feature API, `@tokamak/sdk`                         |
| `packages/ui/`      | TypeScript UI library, `@tokamak/ui`                           |
| `packages/build/`   | Private shared Vite/Solid/theme build integration              |
| `app/`              | Thin product shell, reserved for Core and plugins              |
| `lab/`              | Independent native UI component catalog and interaction checks |

Root `plugins/` contains the installed Chat and ACP plugins.
Cargo/Bun manifests and lockfiles remain at the repository root. Public package
names remain unchanged; `app` and `lab` are separate application projects.

## CI

Depot CI runs a fast 2 CPU Linux gate on pull requests, pushes to any branch,
and merge queues: formatting (including Rust), TS lint/typechecks, SDK build/type
and unit tests, and release coordination tests. Documentation-only changes
(markdown, `docs/`, `wiki/`, `.tmp/`) skip CI. Per-ref concurrency cancels older runs.

Rust compilation/clippy, native tests, the 51-second ACP Bun suite, and offline
Vello captures run on `main`. A measured native run took almost 14 minutes even
with compiler cache hits, so this heavier gate stays off ordinary PRs. macOS uses
Depot's `depot-macos-latest` Actions runner on `main`; on a PR it runs only with
the explicit `ci:macos` label. It checks the full gate using Metal. Linux uses
Mesa lavapipe for headless rendering. Login-dependent adapter tests stay ignored;
the interactive GUI smoke task remains manual because it needs a window server.
Clippy retains the local gate's advisory behavior.

Run the Linux workflow against your local worktree (a branch runs only fast checks):

```sh
depot ci run --workflow .depot/workflows/ci.yml
# Or iterate on one job:
depot ci run --workflow .depot/workflows/ci.yml --job typescript
```

Depot Cache stores moon results and release binaries, Rust compiler objects via
sccache, Cargo registry/git downloads, Bun downloads and pinned proto/moon/Rust
installs. The fast job skips Cargo downloads, clippy and sccache installation.
Verification stages hash workspace sources and platform identity because fixtures
and imports span project boundaries; CI uses the full fast gate instead of an
incomplete affected-project graph. Generated files and dependencies are excluded.
Export `DEPOT_TOKEN` locally to share moon's remote cache; without it, moon
disables remote storage with a warning and local commands work normally.
For local Rust cache sharing use `depot cargo`, or configure sccache with Depot's
WebDAV endpoint and your Depot token. CI uses injected short-lived credentials.

ACP emits JUnit XML for Depot's test results dashboard, including failed runs.
Moon restores the report when the heavy verification stage is cached. Inspect it
with `depot tests <run-id> --job native`; other suites use workflow logs.

After the main gates pass, Linux server binaries (x64/arm64) and macOS server +
desktop binaries (arm64) are archived with SHA-256 checksums. Each platform stages
assets in a draft for that commit; the Actions publisher replaces the single
[`nightly` prerelease](https://github.com/pixelscortex/tokamak/releases/tag/nightly)
only when all four archives are present, valid, and still match `main`. The prior
nightly remains until the complete replacement is ready. Publication uses the
built-in `GITHUB_TOKEN` with `contents: write` on Depot and Actions, with no extra
secret. Workflow artifacts are also retained for 7 days. Signing and macOS
notarization will be added before packaging; deployment remains a later step.

## Quick start

Install [Bun](https://bun.sh) (required for plugin workers), [proto](https://moonrepo.dev/proto) and rustup, plus the native build
prerequisites for your OS (Xcode command-line tools on macOS). From this checkout,
run `proto use` to install the pins in `.prototools`: Bun 1.4.4, Moon 2.5.6 and
Rust 1.97.0. Put proto's bin/shims and Cargo's bin directory on `PATH`.

Install the agent adapters once (requires Node.js/npm):

```sh
npm install -g @agentclientprotocol/claude-agent-acp@0.106.0 @agentclientprotocol/codex-acp@2.6.0
```

Tokamak automatically finds `claude-agent-acp`, `codex-acp`, and Gemini CLI
(`gemini --acp`) on PATH and in common global install directories, including
`~/.local/bin`, `~/.npm-global/bin`, `~/.bun/bin`, `~/.local/share/vite-plus/bin`,
`/opt/homebrew/bin`, `/usr/local/bin`, and `~/.volta/bin`.
Discovery refreshes whenever agents are listed, so adapters installed while the
app is running appear without restarting. Sign in with `claude` or `codex` in a
terminal first. The adapters reuse existing logins in `~/.claude` and `~/.codex`;
`PATH`, `HOME`, `USER`, and `LANG` (when present) are passed through. Each adapter's
installation directory is prepended to its PATH so toolchain helpers are available.

Then run from the repository root:

```sh
bun run app
```

This installs workspace dependencies, builds Chat, the UI and Rust binaries,
starts the local server, and opens chat. Type a message and press Enter.
Closing the desktop leaves the server running; `bun run server:stop` stops it.
After changing the server environment, stop the server and run `bun run app` again.

Enter sends; Shift+Enter adds a line; Esc stops your reply or closes a picker.
Tab opens/closes Map; type to search, arrows/Enter select, and 1–9 open a row
with an empty search. Cmd+N creates a thread. In Map with an empty search,
R renames and Cmd+Backspace deletes (Enter confirms, Esc cancels).
Cmd+M selects an agent; Cmd+Shift+C copies the last assistant reply.
With an empty composer, 1–4 answers agent permissions.

New threads select the first available agent. Use Cmd+M to configure its absolute
working-folder path. Without an agent, the composer shows
"No agents found. Install `claude-agent-acp` or `codex-acp` (see README)" and sending is refused.

See [Chat details](plugins/chat/README.md) for thread and backend contracts, and
[ACP setup](plugins/acp/README.md) for installed coding agents and smoke tests.
`bun run app` builds and loads both plugins. Backend storage changes have no
migration before beta; existing local data may be reset.

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

## Commands

With proto and rustup available, run from the repository root:

```sh
moon run :check
moon run :test
moon run :build
moon run :size
```

Root Bun aliases are `bun run build` (server + desktop release), `bun run check`,
`bun run test`, and `bun run app` / `bun run app:dev` (debug build and launch). They invoke the existing
Moon/Cargo orchestration, not browser HMR or an unpinned installer.

`proto run bun -- run check` runs the formatting check, TS lint, and advisory Rust
lint. Run `moon run workspace:format` to apply Oxfmt and rustfmt, or
`moon run workspace:format-check` to check without writing. Oxfmt is pinned at
0.78.0 with 2-space indentation, double quotes, semicolons, a 110-column width,
and trailing commas. Generated output, dependencies, vendor code, and lockfiles
are excluded. The minified engine source-map fixtures also stay byte-for-byte intact.

Oxlint errors enforce unused variables, console usage (except build tooling,
tools, and tests), strict equality, const declarations, no `var`, no debugger,
and import cycles. Explicit `any` and the existing size/complexity rules warn.
The command-line server demo writes its results directly to stdout/stderr.
Clippy remains advisory because existing Rust warnings do not pass `-D warnings`.
Use `.git-blame-ignore-revs` to skip the repository-wide formatting commit:
`git config blame.ignoreRevsFile .git-blame-ignore-revs`.

`bun run plugin:build <folder>` produces the versioned artifact described in
`packages/build/README.md`. Unchanged output bytes are not rewritten; generated
native context keeps embed paths out of application entry points.

The desktop connects to an independent local server. `bun run app` starts or
reuses it; desktop exit does not stop it. `bun run server:status`,
`bun run server:stop` and `bun run server:start` control the local service.

`bun run ui:lab` opens the component catalog without starting a server or
touching user storage.
An isolated standalone build at `app/dist/tests/record` supports the native,
compiler and five E2E regressions.

`.prototools` pins moon, Bun, and Rust. Moon's built-in toolchains read those
pins and manage their tool caches and dependency installation; no custom proto
plugins are needed. Moon synchronizes the Rust pin into the checked-in
`rust-toolchain.toml`, so rustup selects the pinned compiler even when its user
default differs. Change Rust's version in `.prototools`, not in that generated
selection file. Bun's native `check` supplies TypeScript checking without a
separate compiler package. TypeScript tasks invoke Bun through `proto run` so an
older Bun in the global install directory cannot shadow the pin under moon 2.5.6.

Cargo tasks are inherited by the Rust crates and share Cargo's incremental
artifacts. SDK tooling uses Bun; UI and renderer use TypeScript + Vite's native
Solid universal build, not browser DOM output. Package tests include real native
QuickJS/Blitz fixtures. The desktop application has real build/check tasks and
independently authored application regressions. Its zero-options Vite integration
uses fixed internal conventions; Chat is an installed plugin.
Linting is deferred.

### Opt-in compiler-selection regression

Run `python3 tests/compiler-selection.py` with Python 3.8+, Git, proto, moon,
Bun, and rustup available, and both the pinned Rust and a different Rust compiler
already installed. The smoke test downloads no compilers and reports an unmet
prerequisite if either compiler is missing. It runs the exact `moon run :build`
and `moon run :size` commands in a disposable source copy with an isolated rustup
home whose default differs from the project pin. A forwarding wrapper verifies
the compiler used for real crate compilation, not just version probes. Temporary
sources, artifacts, and settings are cleaned up on success or failure; global
rustup settings and the original workspace's build artifacts are untouched.

`moon run :size` builds and measures both the headless release host and the
composed desktop executable, not just separate TypeScript output, on the current
host target with Cargo's default target configuration. Release builds enable full
LTO, symbol stripping, and one codegen unit. On `aarch64-apple-darwin` with Rust
1.97.0, `s` measured **286,080 bytes**, versus **286,096 bytes** for `z`, so `s`
is selected. Remeasure both as dependencies arrive; this is not a cross-platform
size guarantee. The pre-scaffold workspace had no binary or size task, so its
baseline and size delta are **unavailable**, not zero.

## TKM-18 layout validation

The mechanical package relocation preserves package exports, sibling native
paths, generated protocol parity and the single Tower execution stack. The
desktop app was still unimplemented at that layout-only checkpoint; its then-empty
project was not acceptance evidence.

Validated with `CARGO_BUILD_JOBS=2 moon run :check :test :build :size` and direct
`ui:check ui:build ui:test render:check render:build render:test` plus
`server:check server:protocol-check server:test`. Native fixtures include the
independently authored UI regressions and production TSX/source-map builds in
checkouts with spaces. The shipped `packages/server/demo` was bundled and run
with two real SDK clients against the release host; live delivery, SIGTERM and
disk reopen preserved the committed fixture row.

On this aarch64 macOS workspace, the headless host measured **39,542,336 bytes**
(baseline 39,542,352; **-16 bytes**) and the native demo **8,617,216 bytes**
(baseline 8,617,216; **no change**). The native foreground/manual gate remains
paused; automated checks do not establish physical native input acceptance.

`python3 tests/compiler-selection.py` failed before compilation because its
existing `git clone --local` setup tried to hardlink across filesystems. That
separate harness defect was not changed as part of this layout refactor.
