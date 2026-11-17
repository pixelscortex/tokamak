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
