# Tokamak

A Cargo and Bun workspace for a TypeScript-first application hosted by Rust.
This scaffold contains no application behavior or runtime dependencies yet.

| Directory | Purpose |
| --- | --- |
| `server/` | Native host crate; builds the `tokamak` executable |
| `runtime/` | Shared JavaScript host runtime crate |
| `render/` | Native UI renderer crate |
| `sdk/` | TypeScript feature API, `@tokamak/sdk` |
| `ui/` | TypeScript UI library, `@tokamak/ui` |
| `apps/desktop/` | Reserved native desktop composition |
| `app/todos/` | Reserved built-in feature, using the future plugin path |

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
artifacts. The SDK and UI inherit Bun checking, tests, and plain ESM bundling to
`dist/`. Empty test suites succeed intentionally. The two application placeholders
have explicit no-op tasks until they gain source code. Linting is deferred.

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
