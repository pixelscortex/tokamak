# Desktop application

The single desktop entry is `src/main.rs`, producing `tokamak-desktop` (not
the headless `tokamak`). It connects to an independently running local server
over authenticated loopback WebSocket. The server embeds storage and backend
workers; the desktop contains only the native UI and its client transport.
There is no routing, plugin loader or Rust Todo implementation.

## Run

```sh
CARGO_BUILD_JOBS=2 moon run app:build
bun run app
bun run server:status
bun run server:stop
bun run server:start
```

`bun run build` builds the server and desktop. `bun run app` starts or reuses
the local server, then launches the desktop. Closing or crashing the desktop
does not stop the server; `server:stop` explicitly drains and stops it.
These are aliases for Moon, not a browser development server or HMR.
The fast debug build path is tracked separately in TKM-41.

Add a task in either panel, toggle its completion Button, then remove it. Both
panels subscribe independently through `useQuery` and update from the same
committed backend state. Quit by closing the window, then reopen the executable:
remaining tasks retain their titles and completion state.

`moon run app:check` checks application TypeScript and the Rust host.
`moon run :size` measures both the headless server and the composed desktop
executable's reachable release code.

`moon run app:test` builds the production feature and UI bundles, checks the
typed test scripts, and runs the independent Solid lifecycle and headless native
document tests. The retained in-process harness drives real Input/Button events
through the SDK, QuickJS and isolated SurrealKV storage under ignored
`dist/tests/`. They check two-panel synchronization, disabled/pressed controls,
quit/reopen persistence, cleanup, accepted-write shutdown and terminal errors.
Compiler regressions also run the zero-option Vite config from workspace and app
working directories in an isolated checkout with spaces. They check generated
HTML/CSS, original frontend/backend maps, missing-input and build failures,
SSR/DOM guards, and the separation of runtime and build-tool ambient types.
These automated checks do not replace the physical foreground-window/IME gate.
Production socket tests separately verify bounded admission, accepted-request
drain on UI retirement, server survival, reopening and terminal server loss.
Local launcher tests cover concurrent start/reuse, private capabilities,
Origin rejection, bundle revision mismatch, graceful shutdown and persistence.

## Bounded POC data policy

Titles must be nonblank after trimming and at most 200 UTF-16 code units.
An add also measures its actual post-insert full-list JSON, including UTF-8,
JSON escaping, generated IDs, and creation timestamps. Every completion flag is
budgeted as `false` (the larger representation), so toggling cannot grow an
approved list beyond the budget. The limit is 48 KiB, reserving 16 KiB of the
native envelope for protocol and topic overhead. There is no hidden count cap
or silent list truncation. The UI reports rejected adds without clearing input;
remove a task to free space.

The check runs before commit in the same SDK transaction as insertion; a failed
check rolls the add back. This aggregate policy relies on the existing single
server coordinator serializing whole handlers across all sessions. It must be
revisited with a shared transactional guard if feature handlers become concurrent.

## Boundaries and lifetime

- `backend/` is the explicit SDK discovery root: schema, Todo functions, and the
  private data-budget helper. Feature IDs remain `todo:list`, `todo:add`,
  `todo:toggle`, and `todo:remove`. The generated API lives in
  `backend/_generated/`; the SDK still owns validation and registry generation.
- `src/` contains Rust hosting and the Solid frontend. `src/main.tsx` mounts the
  core Todo screen from `src/pages/todos.tsx`, without routing or plugin packaging.
  Frontend code imports generated references, never schema or handler values.
- Root `vite.config.ts` installs the zero-options internal `@tokamak/build/vite`
  integration. It reuses SDK bundling, the shared guarded Solid universal compiler,
  and the shared Tailwind compiler. Minimal HTML, the mount point, and compiled
  CSS are generated into `dist/shell.html`; no app-specific HTML is maintained.
  Backend maps are rebased when copied from `backend/dist/` into `dist/`.
- `runtime::client` owns discovery, executor, WebSocket and window disposal;
  `src/main.rs` only declares assets and configuration. Its connection feeds owned
  JSON requests to one server WebSocket session. Its
  64-entry request queue has a 64 KiB per-message limit. Session events remain
  ordered through the renderer's bounded generation-scoped mailbox; a reserved
  terminal envelope rejects pending promises on failure even at capacity. Error
  diagnostics are capped at 1024 Unicode scalars before terminal serialization.
- QuickJS callbacks stay on the UI thread. Subscriptions are disposed with their
  Solid owner. Closing the window stops admission and forwards queued requests
  through awaitable Tower capacity without retry. At most one native command
  awaits completion: the next is admitted only after its response, initial
  subscription result, or unsubscribe acknowledgment has been consumed from the
  one ordered session stream. This prevents a ready burst of cheap commands from
  filling the server output queue before the native receiver can run. Output
  keeps draining during shutdown for up to five seconds. The desktop never owns
  backend shutdown. A timeout, process crash or forced termination can leave
  mutation outcomes unknown; requests are never automatically retried.
- `tests/support/embedded.rs` preserves the older in-process transport only for regression
  tests. It is not linked into the desktop's normal dependency graph.

## Storage

The server uses `directories` 6.0.0 for the standard application-data location. On
macOS the database is
`~/Library/Application Support/com.pixelscortex.Tokamak/store`.
The app fails explicitly if that location cannot be determined or opened; it
does not fall back to volatile storage or put a database in the source tree.

Apple documents `FileManager.SearchPathDirectory.applicationSupportDirectory`
as `Library/Application Support`; `ProjectDirs::data_local_dir` applies the
application-specific suffix. Primary references:

- https://developer.apple.com/documentation/foundation/filemanager/searchpathdirectory/applicationsupportdirectory
- https://docs.rs/directories/6.0.0/directories/struct.ProjectDirs.html
- https://crates.io/crates/directories/6.0.0

The same directory holds private `server.token`, public discovery `server.json`
and `server.log`. Discovery contains a loopback URL, PID and loaded bundle hash,
never the capability. Health is checked with an Authorization header before
reuse. A changed backend bundle requires an explicit stop/restart; changing
native server code likewise requires a restart. There is no crash supervisor,
automatic reconnect, remote account authentication or TLS.

`TOKAMAK_SERVER_DIR` selects an isolated directory for testing/development.
The launcher resolves relative overrides from the repository root. Directly
launching the desktop requires a server already started in that directory.
A crashed launcher can leave `server-start.lock`; startup then fails explicitly
rather than stealing a lock or killing an unverified PID.

The crate is MIT/Apache-2.0, 17,842 bytes compressed upstream, and has no optional
feature stack. It replaces hardcoded home-directory path construction. Native
foreground editing/IME and visual presentation still require the renderer's
separate physical macOS gate; injected document events do not establish it.
