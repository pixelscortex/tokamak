# Product shell

This is the thin native client, ready for deliberate Core/plugin contracts.
The backend is currently an empty registry. Todo is retired and retained only
under `tests/fixtures/todo`; the independent component catalog is root `lab/`.
There is no product router, plugin loader or invented Core schema yet.

## Commands (repository root)

```sh
bun run app            # build/start or reuse server, then launch desktop
bun run build          # explicit release server + desktop
bun run ui:lab         # independent native UI, no backend/storage
bun run server:start
bun run server:status
bun run server:stop
```

`runtime::client` owns native execution, local WebSocket discovery and bounded
client disposal. Main declares only title, geometry and assets. The server
survives desktop quit/crash. Explicit stop awaits backend/storage shutdown.
Fast debug/incremental asset publication and generated context wiring remain
TKM-41, not this Todo retirement step.

## Local service

The existing macOS store is unchanged:
`~/Library/Application Support/com.pixelscortex.Tokamak/store`.
No data deletion or migration occurs. Do not open that store in two processes.

The directory also holds private `server.token`, public discovery `server.json`
and `server.log`. The launcher verifies readiness and the loaded bundle hash
before reuse. A different bundle requires explicit stop/restart. Native server
code changes likewise require restart. Capability authentication is local-only,
not account authentication, remote deployment, TLS or crash supervision.

`TOKAMAK_SERVER_DIR` selects an isolated directory. Launcher-relative overrides
resolve from the repository root. A crashed launcher can leave `server-start.lock`;
startup fails explicitly instead of stealing a lock or killing an unverified PID.

The runtime connection bounds admission at 64 requests / 64 KiB each and keeps
one completion outstanding. Client shutdown drains for up to five seconds;
timeouts/disconnections can leave mutation outcomes unknown. No automatic retry
or reconnect is provided.

## Validation

`moon run app:test` builds the retired fixture, exercises compiler/Solid lifecycle
regressions, the original real native controls and data policy, the production
socket bridge and actual standalone server ownership/auth/persistence.
`tests/support/embedded.rs` exists only for in-process regressions.
`moon run :e2e` retains the original five POC scenarios on isolated fixture data.
No tests open the real user store.

`moon run lab:test` separately checks the actual UI catalog. Physical native
close/IME/VoiceOver and visual presentation remain separate manual acceptance.
