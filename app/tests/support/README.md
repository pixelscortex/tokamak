# Native regression harness

`embedded.rs` retains the in-process transport for existing native and E2E
regressions. Production desktop transport is `app/src/socket.rs`; its tests
start the real independent server using isolated storage.
