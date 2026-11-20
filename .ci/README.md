# CI and unsigned release

All CI runs in GitHub Actions, on Depot's runners. `.github/workflows/ci.yml` runs
three fast jobs on every PR, and `.ci/check.sh` holds their commands:

- `lint`: formatting and lint for TypeScript and Rust (Clippy, warnings denied). These
  do not depend on the platform, so they run once.
- `typescript`: type checks, TypeScript unit tests and the web build.
- `rust`: unit tests inside the Rust crates.

Integration, end-to-end and browser suites are not run in CI for now. They stay
runnable locally: `cargo test --workspace`, `proto run bun -- e2e/run.ts`,
`proto run bun -- run e2e:browser` (see `e2e/README.md`), and
`proto run bun -- test plugins/acp`.

Pull requests and pushes to `main` or `dev` run only the cheap Linux jobs: lint,
TypeScript and Rust. Draft pull requests are skipped; the jobs start when a pull
request is marked ready for review. `dev` is the integration branch: feature pull requests target
it, and `main` is updated from it. The `desktop-mac` and `desktop-windows` jobs build the
unsigned apps only when the workflow is started by hand (Actions → CI → Run
workflow), because desktop runners cost more (macOS 20×, Windows 2× Linux). They build,
smoke-check the server's `--build-id` and upload the bundle (`desktop-mac-<arch>`,
`desktop-windows-x64`); they run no test suites. Download caches cover pinned
tools, Bun and Cargo; sccache covers Rust compilation on Linux and macOS.

Run `bash .ci/release-macos.sh` on macOS arm64 for a manual local release, or
manually dispatch the **Unsigned macOS release** workflow. The Tauri hook builds
the release server sidecar and Chat resources before bundling. Outputs are
`.ci-results/macos-arm64/Tokamak.app`, `Tokamak-macos-arm64.zip`, the standalone
`server-macos-arm64.tar.gz`, and `SHA256SUMS.txt`. The zip preserves macOS bundle
metadata. Actions artifacts wrap the directory for download; use the inner zip
to distribute the app. Nothing is signed, notarized or published.

`MACOS_SIGNING_IDENTITY` and `MACOS_NOTARIZATION_PROFILE` (also named workflow
inputs) reserve the future signing identity/keychain profile configuration.
Leave both empty; nonempty values currently fail instead of suggesting that the
artifact is signed. No secrets are required. Running the CI workflow by hand on `main` still
produces standalone server archives for x64 and arm64 as download artifacts.
The former nightly publishing helper remains available for existing server
release consumers, but these workflows do not invoke it.

## Versions

Everything we own carries one version, the `version` field of the root
`package.json`. That covers every Bun workspace package that declares a version, the
plugins in this repo (`plugins/*`: their `package.json` and the `version` in
`plugin.ts`), the Cargo workspace version (every crate inherits it with
`version.workspace = true`) and `app/src-tauri/tauri.conf.json`, which names the
desktop bundle (`Tokamak_<version>_x64-setup.exe`). The server's crate version is also
the host API version that plugins require through `api` (default `tokamak@^0.1`). ACP
sends its plugin version to agents as `clientInfo`.

Change it everywhere in one step with `proto run bun -- run version:set 0.2.0`; it
rewrites those files and then the lockfiles (`bun install`, `cargo update --workspace`).
The `lint` job runs the check (`.ci/versions.ts check`, also `proto run bun -- run
version:check`), which fails and lists each file and value that differs. It finds the
places itself, so a new package or plugin is covered once it joins a workspace; a
`package.json` with no `version` field is allowed.

Test fixture plugins (`packages/*/tests/fixtures`, `app/tests/fixtures`) are not
workspace packages and keep their own versions. Tests bump them on purpose to exercise
grants and dependency ranges.

A plugin's version is also the key of its capability grant (`<id>@<version>`) in the
data folder. The server refuses to start when a stored grant for that key lists other
permissions. Moving `chat` from 0.3.0 to 0.1.0 has this effect once: a data folder that
ran the old chat 0.1.0 (2026-11-15/16, with the OpenRouter permissions) holds a
`chat@0.1.0` grant with three permissions, and the server stops with
`Permissions changed for chat@0.1.0; bump its version before granting. The data folder
<path> already granted ...`. To clear it, stop the server and delete the data folder the
message names; this erases all of its data. Data folders created later start normally.

## Windows desktop

The Windows job runs on pushes to `main` and when the workflow is started by hand. It is
skipped on pull requests.

`desktop-windows` builds an unsigned x64 NSIS installer on Depot's documented
`depot-windows-2025` runner. It is temporarily
`continue-on-error: true`; remove that once builds and installed-app smoke checks
are reliable. It builds and bundles the app, runs the server's `--build-id` smoke
check, and uploads the installer. The job reads the runner's logical CPU count
and uses it for `CARGO_BUILD_JOBS` and `RAYON_NUM_THREADS`; Depot documents this
runner as 2 CPUs and 8 GB of memory.

Tool and dependency downloads use Actions caches. A separate Windows-only
Actions cache stores `target/release`, excluding installer bundles and incremental
files. This reuses compiled dependencies, build scripts, proc macros and linking
outputs; Cargo still checks whether inputs changed. The key includes the x64
MSVC target, architecture, pinned toolchain files, Cargo lockfile/manifests and
Cargo configuration, with a commit suffix. A matching prefix restores the latest
compatible build after a source change; successful builds save a new entry after
the smoke check. Exact hits do not upload again. Depot backs these Actions caches
and controls their retention and storage limits at the organization level.

The cache also records hashes and timestamps for tracked inputs. Before building,
`.ci/windows-cache-inputs.mjs` restores a timestamp only if the file's SHA-256
matches the saved input, so Cargo can reuse unchanged workspace crates after a
fresh checkout. Changed or new files get fresh timestamps to invalidate stale
outputs. Generated plugin/frontend resources are rebuilt normally.

Windows does not use sccache. The earlier validation explicitly enabled its GHA
backend (`SCCACHE_GHA_ENABLED=true`), which reported `ReadOnly`, zero cache writes
and 263 write errors. This was not the WebDAV backend described in Depot's
sccache documentation. A diagnostic reproduced its startup failure:
`ghac returns invalid signed url that sas is missing`. sccache's GHA client
expects an Azure SAS upload URL, which Depot's cache proxy did not return;
sccache therefore disabled writes. The pinned Actions cache client successfully
saves/restores archives through that proxy. Caching Cargo's release directory also covers the Rust
binaries and proc macros that sccache reported as non-cacheable. Linux/macOS
retain their existing sccache configuration.

Runner and cache documentation: [Windows runner sizes](https://depot.dev/docs/github-actions/runner-types#windows-runners),
[Depot Actions cache](https://depot.dev/docs/cache/integrations/github-actions),
[Depot sccache configuration](https://depot.dev/docs/cache/integrations/sccache).

Download **desktop-windows-x64** from the CI run's Artifacts section (or use
`gh run download <run-id> -n desktop-windows-x64`). Extract the artifact and run
`Tokamak_0.1.0_x64-setup.exe` on Windows x64. The artifact expires after seven days.
The installer is unsigned; Windows may require accepting its unknown-publisher
prompt. No signing secrets are required.

Plugin workers and ACP agents run on Windows with Bun installed. The server
creates each worker inside a Job Object that ends the whole process tree when the
server closes the job handle or exits. The app's server probes and sidecar, Bun
workers, and ACP agent launches do not open a console. Windows CI checks the
build and server identity only; it does not run worker or ACP tests, launch the
installer or desktop UI, or run real Claude or Codex adapters.

On a Windows PC, install and open the bundle, then switch servers. No terminal
should appear. With Bun and an authenticated adapter on `PATH`, check that the app
offers the adapter, opens a session in a folder with spaces, streams a reply, and
handles cancellation. When the local server stops, no worker or adapter processes
should remain. Also check local server authentication, persistence, and upgrade
behavior. The host uses graceful HTTP server shutdown; its Unix SIGTERM fallback
is not available on Windows. Token files rely on the user's inherited Windows
profile ACLs rather than Unix mode bits.
