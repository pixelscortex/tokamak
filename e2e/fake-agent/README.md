# Shared fixture helpers

These helpers drive the real Tokamak Server and Runner with test fixture plugins
and disposable data. They do not load installed plugins or need agent logins.

- `harness.mjs` builds and copies fixture sources, starts the Server, connects
  SDK clients over WebSockets, waits for live queries, and signs in test members
  through a fixture sign-in provider.
- `start-runner.ts` launches a private Runner and gives test clients a way to
  call its local plugin parts. `local.mjs` also provides a direct launcher for
  server fixtures using the native plugin host.

Plugin-specific end-to-end tests and replays are maintained in
[tokamak-plugins](https://github.com/pixelscortex/tokamak-plugins).
The repository privacy check is `proto run bun -- .ci/privacy-scan.mjs`.
