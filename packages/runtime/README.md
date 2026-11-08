# Runtime hosts

`runtime` composes application lifecycles. `engine` owns QuickJS execution,
budgets, source maps, host operations and the worker pool.

- No default features.
- `client`: native window, local discovery, WebSocket connection and bounded
  client drain. It never starts/stops the server or opens storage.
- `server`: exposes the existing Backend/config/storage and engine bundle types.
  It does not add another backend implementation.

`client::run(ClientConfig)` hosts a connected app.
`client::run_ui(ClientConfig)` hosts UI-only tools without server discovery or
network state. Product entry points declare assets/configuration only.

The client dependency graph has no database; the server-only graph has no GUI.
Owned bounded messages cross threads, never QuickJS handles.
JSON text conversion remains unchanged; TKM-17 is deferred.
