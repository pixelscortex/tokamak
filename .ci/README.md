# CI and unsigned release

Depot's `.depot/workflows/ci.yml` runs TypeScript, blocking Rust lint and the native
stage on every PR. Rust lint checks all targets and features in every remaining
workspace crate, including `app/src-tauri`, with warnings denied. Native installs
the Linux Tauri libraries and Playwright's Chromium/WebKit dependencies. Download caches cover pinned tools, Bun, Cargo and
Playwright browsers; sccache covers Rust compilation. GitHub's macOS CI builds the
unsigned Tauri bundle on every PR. `.ci/check.sh` contains the stage commands.

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
artifact is signed. No secrets are required. Linux's manual Depot release still
produces standalone server archives for x64 and arm64 as download artifacts.
The former nightly publishing helper remains available for existing server
release consumers, but these workflows do not invoke it.
