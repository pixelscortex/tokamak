# Native regression harness

`embedded.rs` retains the in-process transport for existing native and E2E
regressions. Production transport is `packages/runtime/src/client/connection.rs`; its tests
start the real independent server using isolated storage.
