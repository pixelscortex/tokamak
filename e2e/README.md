# Server end-to-end checks

Run `proto run bun -- run e2e` from the repository root.

The runner uses the real server and SDK. It creates a record through a mutation,
toggles it, stops and reopens the store, and checks exact persisted rows. Two
independent WebSocket clients must both receive a committed update. A separate
single-worker fixture verifies CPU-budget interruption and the next healthy call.
Temporary stores and processes are cleaned up. No user store is opened.

The former native window driver and its capture/interaction fixtures are gone.
The reusable record server fixture lives in `packages/server/tests/fixtures/record`.
`tests/compiler-selection.py` separately checks pinned Rust selection when its
two-toolchain prerequisite is met.

## Browser checks

Install the real browsers once, then run the production build harness:

```sh
proto run bun -- x playwright install --no-shell chromium webkit
proto run bun -- run e2e:browser
proto run bun -- run e2e:browser --repeat-each=3
TOKAMAK_E2E_CPU_RATE=6 proto run bun -- run e2e:browser --project=chromium --repeat-each=10
proto run bun -- e2e/browser.ts --fixtures-only app.spec.ts servers.spec.ts sign-in.spec.ts quit.spec.ts --project chromium
```

On Linux use `playwright install --with-deps --no-shell chromium webkit` through the same
pinned Bun command. Ports 1420, 1421, 43123 and 43124 must be free (set `TOKAMAK_E2E_PORT` to override 1420); the runner refuses to
reuse a running app. It builds the server and plugins, builds Vite in production
mode, and serves it with Vite preview. Every run owns a
fresh store, private capability and plugin installation. Fixture source edits happen in a disposable
copy under `app/.dev`, never in the checkout's source fixture. Processes and
stores are removed on exit. No credentials or external agents are needed.

Use `--fixtures-only` to run the shell specs: `app.spec.ts`, `servers.spec.ts`,
`sign-in.spec.ts`, `quit.spec.ts`, and `screens.spec.ts`. This installs just the
integration fixture, the other-draft fixture, and the fixture Password provider.
To capture the shell screenshots, set `TOKAMAK_SCREENS` to an output directory
and select `screens.spec.ts` with this flag.

The default run also builds the real plugins for `chat.spec.ts`, `thread-list.spec.ts`,
`ai.spec.ts`, `ai-thread.spec.ts`, `ai-quit.spec.ts`, `code.spec.ts`, and
`plugin-screens.spec.ts`. The two screenshot specs run only when
`TOKAMAK_SCREENS` is set.

Add tests in `e2e/browser/*.spec.ts`. Select by role and accessible name; keep
layout and styling out of assertions. Wait for live state with Playwright's
assertions, without sleeps. Use the observed thread count as a baseline, since
browser projects share one disposable server. Keep fixture rebuilds serial.
The host accessibility contract includes `Connection status`, `Sidebar`, `Page header`,
`Panel`, `Views`, `Open pages`, `Settings`, `Server unreachable`, `Plugin view error`, the
switcher's `Server: <name>` button and the `Add a server` region with its `Server address`,
`Invite token` and `Your name` fields; the fixture adds `Fixture threads`, `New fixture thread` and `New thread title`.
Keep those names when restyling the host.
Use `--project=chromium` or `--project=webkit` to narrow a run. Failure traces and
HTML reports live under `.ci-results/playwright*` and are uploaded by native CI.

Chat runs on its own, as pure threads: the new thread on opening, the thread made
on the first Send, a second page seeing messages live, rename by double-click,
delete from the menu, and a chosen folder offered again. `TOKAMAK_E2E_CPU_RATE`
applies Chromium CPU throttling to the chat checks.

A second server runs in hosted mode on `127.0.0.1:43124` (`e2e/serve-hosted.ts`)
with its own random access token, the integration fixture, and the fixture
Password provider. Plugin specs can request additional plugins on their own
hosted server.
`servers.spec.ts` adds it through "Add a server" (including a rejected token),
switches between it and the first server with ⌘1 and ⌘2, and removes it.

Coverage: connection, adding and switching servers, two-page live thread creation, compiler-built plugin
catalog/navigation and live query, explicit rebuild/reload without replacing the
document, plugin view error containment and recovery, and HTTP/WebSocket origin
rejection. The existing server suite still covers persistence and CPU budgets.
Desktop window automation, OS integration, signing and external agents are outside
this browser suite.

## Turn replays and startup time

The offline replays run once through the QuickJS Runner. They check the turns
stored by the real server and database.

After building `tokamak-runner` and its matching `tokamak-plugin-host`, run:

```sh
proto run bun -- packages/runner/tests/measure-first-text.mjs target/debug/tokamak-runner
```

Add `--real` with a signed-in Codex CLI to measure actual turns outside CI.
The script times delivery of the first text to a Chat subscription and reports
cold (first turn after launch) and warm (second turn) separately.

## Fresh starter installation

Build the server binary, then run the starter smoke in a disposable directory:

```sh
CARGO_BUILD_JOBS=2 cargo build --locked -p server -p tokamak-plugin-host
proto run bun -- e2e/starter.mjs
```

To opt in to one real turn through each installed CLI using its existing login,
also build `tokamak-runner`, then run
`proto run bun -- e2e/starter.mjs --real claude codex`. Pass only one name to
run one provider. Real turns use the Runner; this mode refuses CI.
