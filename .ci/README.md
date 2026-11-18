# CI and unsigned release

All CI runs in GitHub Actions, on Depot's runners. `.github/workflows/ci.yml` runs
TypeScript, blocking Rust lint and the native stage on every PR. Rust lint checks all targets and features in every remaining
workspace crate, including `app/src-tauri`, with warnings denied. Native installs
the Linux Tauri libraries and Playwright's Chromium/WebKit dependencies. Download caches cover pinned tools, Bun, Cargo and
Playwright browsers; sccache covers Rust compilation. The same workflow's `desktop` job builds the
unsigned macOS Tauri bundle on every PR. `.ci/check.sh` contains the stage commands.

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

## Windows desktop

`desktop-windows` builds an unsigned x64 NSIS installer on Depot's documented
`depot-windows-2025` runner on every PR and main push. It is temporarily
`continue-on-error: true`; remove that once builds and installed-app smoke checks
are reliable. It builds and bundles only (no Windows test suites), then runs the
server's `--build-id` smoke check. Tool and dependency downloads use Actions
caches; sccache uses the GitHub Actions backend on Windows.

Download **desktop-windows-x64** from the CI run's Artifacts section (or use
`gh run download <run-id> -n desktop-windows-x64`). Extract the artifact and run
`Tokamak_0.1.0_x64-setup.exe` on Windows x64. The artifact expires after seven days.
The installer is unsigned; Windows may require accepting its unknown-publisher
prompt. No signing secrets are required.

The worker runtime (including the ACP plugin's agent actions) returns an explicit
unsupported error on Windows until Job Object process-tree containment exists.
The host uses graceful HTTP server shutdown; its Unix SIGTERM fallback is not
available on Windows. Token files rely on the user's inherited Windows profile
ACLs rather than Unix mode bits. CI does not launch the desktop UI: a first manual
run should check installation, window rendering, bundled plugin/resource loading,
local server startup/authentication, persistence, restart/reuse and upgrade
shutdown, and confirm worker actions show the unsupported error.
