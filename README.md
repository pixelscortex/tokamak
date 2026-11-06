# Tokamak

A Cargo and Bun workspace for a TypeScript-first application hosted by Rust.
Reusable host, runtime, renderer, SDK and UI packages live under `packages/`.
The single desktop application will be composed directly under `app/`.

| Directory | Purpose |
| --- | --- |
| `packages/server/` | Native host crate; builds the `tokamak` executable |
| `packages/runtime/` | Shared JavaScript host runtime crate |
| `packages/render/` | Native UI renderer crate |
| `packages/sdk/` | TypeScript feature API, `@tokamak/sdk` |
| `packages/ui/` | TypeScript UI library, `@tokamak/ui` |
| `app/` | Single desktop composition root; built-in Todo will live directly here |

Root `plugins/` is reserved for future first-class plugins; it is not scaffolded.
Cargo/Bun manifests and lockfiles remain at the repository root. Public package
names and Moon IDs for real packages are unchanged; the sole app project is `app`.

## Commands

With proto and rustup available, run from the repository root:

```sh
moon run :check
moon run :test
moon run :build
moon run :size
```

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
QuickJS/Blitz fixtures. The `app` project has no fake check/build/test targets:
application source and its composition entry point are deferred to TKM-10.
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

`moon run :size` always builds the release host and prints its file size in bytes.
It measures the host binary, not the separate TypeScript output, on the current
host target with Cargo's default target configuration. Release builds enable full
LTO, symbol stripping, and one codegen unit. On `aarch64-apple-darwin` with Rust
1.97.0, `s` measured **286,080 bytes**, versus **286,096 bytes** for `z`, so `s`
is selected. Remeasure both as dependencies arrive; this is not a cross-platform
size guarantee. The pre-scaffold workspace had no binary or size task, so its
baseline and size delta are **unavailable**, not zero.

## TKM-18 layout validation

The mechanical package relocation preserves package exports, sibling native
paths, generated protocol parity and the single Tower execution stack. The
desktop app is still unimplemented; its empty project is not acceptance evidence.

Validated with `CARGO_BUILD_JOBS=2 moon run :check :test :build :size` and direct
`ui:check ui:build ui:test render:check render:build render:test` plus
`server:check server:protocol-check server:test`. Native fixtures include the
independently authored UI regressions and production TSX/source-map builds in
checkouts with spaces. The shipped `packages/server/demo` was bundled and run
with two real SDK clients against the release host; live delivery, SIGTERM and
disk reopen preserved the committed Todo row.

On this aarch64 macOS workspace, the headless host measured **39,542,336 bytes**
(baseline 39,542,352; **-16 bytes**) and the native demo **8,617,216 bytes**
(baseline 8,617,216; **no change**). The native foreground/manual gate remains
paused; automated checks do not establish physical native input acceptance.

`python3 tests/compiler-selection.py` failed before compilation because its
existing `git clone --local` setup tried to hardlink across filesystems. That
separate harness defect was not changed as part of this layout refactor.
