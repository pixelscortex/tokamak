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

Root `plugins/` contains the installed Chat plugin.
Cargo/Bun manifests and lockfiles remain at the repository root. Public package
names remain unchanged; `app` and `lab` are separate application projects.

## Quick start

Install [proto](https://moonrepo.dev/proto) and rustup, plus the native build
prerequisites for your OS (Xcode command-line tools on macOS). From this checkout,
run `proto use` to install the pins in `.prototools`: Bun 1.4.4, Moon 2.5.6 and
Rust 1.97.0. Put proto's bin/shims and Cargo's bin directory on `PATH`.

Create `.env.local` **at the repository root**, next to `package.json`
(`/Volumes/mypixel/tokamak/.env.local` in this checkout), containing:

```dotenv
OPENROUTER_API_KEY=your-key-here
```

Then run from the repository root:

```sh
bun run app
```

This installs workspace dependencies, builds Chat, the UI and Rust binaries,
starts the local server, and opens chat. Type a message and press Enter.
Closing the desktop leaves the server running; `bun run server:stop` stops it.
After changing keys or agents, stop the server and run `bun run app` again.

Enter sends; Shift+Enter adds a line; Esc stops your reply or closes a picker.
Tab opens/closes Map; type to search, arrows/Enter select, and 1–9 open a row
with an empty search. Cmd+N creates a thread. In Map with an empty search,
R renames and Cmd+Backspace deletes (Enter confirms, Esc cancels).
Cmd+M selects a model/agent; Cmd+Shift+C copies the last assistant reply;
Cmd+Shift+S opens sharing. With an empty composer, 1–4 answers agent permissions.

For agents, copy `agents.example.toml` to
`~/Library/Application Support/com.pixelscortex.Tokamak/agents.toml` on macOS;
on Linux use `$XDG_DATA_HOME/tokamak/agents.toml` (default
`~/.local/share/tokamak/agents.toml`). If set, `$TOKAMAK_SERVER_DIR/agents.toml`
overrides these paths. Install Node.js/npx; the example forwards `PATH` and
`ANTHROPIC_API_KEY` for Claude, `PATH` and `OPENAI_API_KEY` for Codex.
Set those keys in the root `.env.local` or server environment, restart the server,
then select an agent with Cmd+M and enter an absolute working-folder path.

Two credentialed smoke checks after building (both use the root `.env.local`):

```sh
cargo test --locked -p server --test actions chat_real_openrouter_smoke -- --ignored --exact --nocapture
TOKAMAK_CHAT_LIVE=1 TOKAMAK_CHAT_QUICKSTART=1 TK_CAPTURE_DIR=/tmp/tokamak-chat-shots cargo test --locked -p tokamak-app --test plugins chat_screen_socket_workflow -- --exact --nocapture --test-threads=1
```

The second writes `/tmp/tokamak-chat-shots/quickstart.png` using disposable storage.
See [Chat details](plugins/chat/README.md) for tools, agents and longer smoke tests.

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
