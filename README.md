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
grants. OS confinement is applied before exec; see the worker grants below.
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

### Worker grants and OS confinement

Workers and their descendants receive only their data folder and private temp
folder (read/write), verified code and installed plugin files (read-only), Bun
and OS libraries (read/execute as needed), and declared manifest grants:

- `fs:read:<absolute path>` and `fs:write:<absolute path>` (write includes read).
  `~` and `~/…` expand on the host. Relative paths and `..` are rejected. Symlinks
  resolve before launch; missing optional paths confer no authority.
- `fs:write:selected` opts into folders explicitly selected through the backend
  picker's configure action. Only the user-session coordinator approves these;
  plugin calls cannot approve themselves. Host records live in `worker-grants/`,
  outside plugin data. Adding a folder restarts the worker, cancelling active
  actions. Grants accumulate until their host record is removed and the worker
  is restarted. Select `~` explicitly to grant a whole home directory.
- `net` enables network. For workers, existing `net:<host>` grants also enable
  **all** network, including local sockets; these OS policies do not enforce
  per-host DNS/IP rules. Omission denies network.
- `proc:<absolute executable>` (also supports `~/…`) allows that executable.
  `proc:tool:<name>` resolves a securely discovered installed tool, includes its
  package read-only and enumerates executable helpers within that package plus
  its sibling Node runtime. No downloads, shell expansion or executable-directory
  grants occur. Script interpreters such as `/usr/bin/env` must be declared too.
  Executable grants permit arbitrary code interpreted by that runtime; they are
  not argument filters. Permitted interpreters and the Linux dynamic loader can
  run code from readable files; process grants do not constrain interpreted code. With any process grant, Bun itself remains executable.
- `keychain` permits macOS SecurityServer access for CLI login reuse. It does not
  grant direct reads of keychain files. Unknown permissions confer no authority.

`workerLimits: { memoryBytes: 8589934592, pids: 512, cpuPercent: 200 }`
overrides the defaults (8 GiB, 512 tasks including threads, two CPUs). CPU is a
rate limit, not a lifetime budget. Limits must be positive integers; minimum
memory is 64 MiB and minimum task count is 16.

Linux installs Landlock using the kernel's available ABI, `no_new_privs`, and a
small seccomp filter before exec. Anonymous Unix stream socketpairs remain
available for child stdio, including without `net`. Filesystem writes never imply executable
access. The filter blocks network socket creation without a grant, process
creation without a process grant (threads remain possible), and host-inspection
or namespace escape syscalls. Landlock ABI 6 also scopes signals and abstract
Unix sockets to the worker's domain. Older ABIs log a warning about missing
protections; ABI 1 lacks REFER, ABI 1–2 lack TRUNCATE, and ABI 1–4 lack device
IOCTL mediation. Without Landlock the host refuses to start an unconfined worker.
Landlock inode rules cannot express each future child's `/proc/self`. A narrow
seccomp notification broker supplies only `maps`, `stat`, `statm`, `status`,
`auxv` and `cgroup`, read-only, for the kernel-identified calling task. Other opens
continue through Landlock. This lets Bun descendants initialize without granting
access to other processes' procfs files.
A delegated cgroup v2 with memory/cpu/pids controllers creates a per-worker group;
children join it before exec. Without delegation, the host logs a warning and
continues **without aggregate resource limits**. Configure the service manager
with delegation (for example systemd `Delegate=memory cpu pids` and
`DelegateSubgroup=supervisor`, keeping the server in a leaf and workers as siblings).

macOS uses `sandbox-exec`, which is deprecated by Apple but remains functional,
with a deny-by-default profile for file content, execution and network. Metadata
checks remain available (as with Landlock). Signals are restricted to the same
sandbox. File descriptors are capped at 4096 and core dumps disabled using
`setrlimit`; aggregate memory, CPU rate and per-worker pids limits are unavailable
on macOS. `RLIMIT_AS` is deliberately unused because Bun/V8 reserve large virtual
address spaces. Other OSes refuse worker launch.
