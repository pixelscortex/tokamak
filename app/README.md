# Desktop application

The single desktop entry is `_host/main.rs`, producing `tokamak-desktop` (not
the headless `tokamak`). It embeds the real backend and CPU native renderer in
one process. There is no local HTTP/WebSocket listener, routing, plugin loader,
or Rust Todo implementation.

## Run

```sh
CARGO_BUILD_JOBS=2 moon run app:build
target/release/tokamak-desktop
```

Add a task in either panel, toggle its completion Button, then remove it. Both
panels subscribe independently through `useQuery` and update from the same
committed backend state. Quit by closing the window, then reopen the executable:
remaining tasks retain their titles and completion state.

`moon run app:check` checks application TypeScript and the Rust host.
`moon run :size` measures both the headless server and the composed desktop
executable's reachable release code.

`moon run app:test` builds the production feature and UI bundles, checks the
typed test scripts, and runs the independent Solid lifecycle and headless native
document tests. The latter drive real Input/Button events through the SDK,
in-process backend, QuickJS and isolated SurrealKV storage under ignored
`dist/tests/`. They check two-panel synchronization, disabled/pressed controls,
quit/reopen persistence, cleanup, accepted-write shutdown and terminal errors.
These automated checks do not replace the physical foreground-window/IME gate.

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

- `schema.ts` and `todo.ts` are portable SDK backend modules. SDK bundling owns
  function discovery, registry generation, validation, and generated API types.
- `_view/` contains the Solid screen and themed native shell. Its private prefix
  keeps frontend code out of backend function discovery. Frontend code imports
  generated API references, never the backend's schema or handlers at runtime.
- `_tools/` reuses the SDK bundler, guarded Vite universal configuration, and UI
  Tailwind compiler. Generated references and `dist/` are not source artifacts.
- `_host/connection.rs` feeds owned JSON requests to one Tower session. Its
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
  keeps draining during admission and shutdown. Finally the host cancels the
  session and joins the backend commit/storage drain.
  A process crash or forced termination can still leave mutation outcomes unknown.

## Storage

`directories` 6.0.0 uses the platform's standard application-data location. On
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

The crate is MIT/Apache-2.0, 17,842 bytes compressed upstream, and has no optional
feature stack. It replaces hardcoded home-directory path construction. Native
foreground editing/IME and visual presentation still require the renderer's
separate physical macOS gate; injected document events do not establish it.
