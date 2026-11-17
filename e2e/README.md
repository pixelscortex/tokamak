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
```

On Linux use `playwright install --with-deps --no-shell chromium webkit` through the same
pinned Bun command. Ports 1420, 1421 and 43123 must be free; the runner refuses to
reuse a running app. It builds the server, Chat and the integration fixture,
builds Vite in production mode and serves it with Vite preview. Every run owns a
fresh store, private capability and plugin installation. Fixture source edits happen in a disposable
copy under `app/.dev`, never in the checkout's source fixture. Processes and
stores are removed on exit. No credentials or external agents are needed.

Add tests in `e2e/browser/*.spec.ts`. Select by role and accessible name; keep
layout and styling out of assertions. Wait for live state with Playwright's
assertions, without sleeps. Use the observed thread count as a baseline, since
browser projects share one disposable server. Keep fixture rebuilds serial.
The host accessibility contract includes `Connection status`, `Sidebar`, `Page header`,
`Panel`, `Views`, `Open pages`, `Settings`, `Server unreachable` and `Plugin view error`; the fixture adds `Threads`, `New thread` and `New thread title`.
Keep those names when restyling the host.
Use `--project=chromium` or `--project=webkit` to narrow a run. Failure traces and
HTML reports live under `.ci-results/playwright*` and are uploaded by native CI.

Coverage: connection, two-page live thread creation, compiler-built plugin
catalog/navigation and live query, explicit rebuild/reload without replacing the
document, plugin view error containment and recovery, and HTTP/WebSocket origin
rejection. The existing server suite still covers persistence and CPU budgets.
Desktop window automation, OS integration, signing and external agents are outside
this browser suite.
