# Product shell

This native client hosts one shared Solid/renderer/SDK runtime and a memory
router. It discovers installed plugin manifests and loads UI modules on demand.
Todo lives at `../plugins/todo`; the component catalog remains root `lab/`.
The app's own backend registry is empty; installed plugins own feature schemas.

## Commands (repository root)

```sh
bun run app            # debug build/start or reuse server, then launch desktop
bun run app:dev        # same development path
bun run build          # explicit release server + desktop
bun run ui:lab         # independent native UI, no backend/storage
bun run server:start
bun run server:status
bun run server:stop
```

`runtime::client` owns native execution, local WebSocket discovery and bounded
client disposal. Main consumes a generated context; `app.config.json` declares
title and geometry. The server
survives desktop quit/crash. Explicit stop awaits backend/storage shutdown.
The shared artifact builder preserves no-op embed mtimes, and Cargo's build
helper validates the artifact and generates context into OUT_DIR.
Release/full-LTO builds remain explicit, not part of the development loop.

## Local service

The existing macOS store is unchanged:
`~/Library/Application Support/com.pixelscortex.Tokamak/store`.
No data deletion or migration occurs. Do not open that store in two processes.

The directory also holds private `server.token`, public discovery `server.json`
and `server.log`. The launcher verifies readiness and the canonical plugin installation root
before reuse. Plugin edits use `tokamak plugin reload <id>`. Legacy bundle
regressions still verify the loaded bundle hash. Native server
code changes likewise require restart. Local discovery accepts only loopback WebSockets.

`TOKAMAK_SERVER_DIR` selects an isolated directory. Launcher-relative overrides
resolve from the repository root. A crashed launcher can leave `server-start.lock`;
startup fails explicitly instead of stealing a lock or killing an unverified PID.

The runtime connection bounds admission at 64 requests / 64 KiB each and keeps
one completion outstanding. Client shutdown drains for up to five seconds;
timeouts/disconnections can leave mutation outcomes unknown. No automatic retry
or reconnect is provided.

## Validation

`moon run app:test` builds a standalone compatibility host from Todo, exercises compiler/Solid lifecycle
regressions, the original real native controls and data policy, the production
socket bridge and actual standalone server ownership/auth/persistence.
`tests/support/embedded.rs` exists only for in-process regressions.
`moon run :e2e` retains the original five POC scenarios on isolated fixture data.
No tests open the real user store.

`moon run lab:test` separately checks the actual UI catalog. Physical native
close/IME/VoiceOver and visual presentation remain separate manual acceptance.


The application is a shared-runtime plugin shell. `bun run app` builds Chat and Todo and
starts/reuses the independent server with `--plugins <workspace>/plugins`.
[The host contract](../packages/runtime/PLUGINS.md) documents contribution slots,
module loading and the separate presentation frame for the current zen screen.

## Chat

The default screen uses the Chat plugin's persisted threads and live message
queries through the shared SDK client. The normal bundle task builds both Chat
and Todo. Set `OPENROUTER_API_KEY` in the ignored workspace `.env.local` before
starting the server; restart an existing server after changing its environment.

Enter sends; Shift+Enter adds a line; Escape stops the current run (its starter or the owner only). Cmd+Shift+S opens the owner's share picker. Tab opens
Map and Tab/Escape closes it. Type to filter thread titles, use arrows and Enter
or 1–9 to open a thread, and use Cmd+Enter in Map or Cmd+N to create one.
Cmd+Shift+C copies the last assistant reply and briefly shows COPIED in the strip.
The selected thread stays in memory for the shell's lifetime. Conversations open
at the end and follow replies until you scroll up; scroll to the bottom to resume.

For an isolated manual run, use `TOKAMAK_SERVER_DIR=/tmp/tokamak-chat bun run app`.
Stop that server with the same variable and `bun run server:stop` after closing
the desktop window.

The existing native socket harness includes `chat_screen_socket_workflow`. Its
default mode stays offline and checks the persisted error state. After building
with `moon run app:bundle`, opt in to the real provider and offscreen GPU captures:

```sh
TOKAMAK_CHAT_LIVE=1 TK_CAPTURE_DIR=/tmp/tokamak-chat-shots \
  cargo test --locked -p tokamak-app --test plugins chat_screen_socket_workflow -- --nocapture --test-threads=1
```

This uses the workspace `.env.local` and disposable storage, sends a long reply prompt, verifies streaming follow/pause/resume, clipboard
contents on macOS, and stopping, and exercises Map search and thread switching.
`markdown.png` captures a short list and a three-line Python block;
`recovery.png` captures a recovered thread after an abandoned run has aged 61
seconds and the native app reopens. `ux-autoscroll.png` captures the completed
long reply at the bottom. Captures use the production Blitz painter with the bundled fonts.

Add `TOKAMAK_CHAT_QUICKSTART=1` for a single-message check with Chat and Todo
installed; it saves `quickstart.png` and skips the longer UX checks.

Add `TOKAMAK_CHAT_TOOLS=1` to that live command to run the Todo card flow
instead: `liquid/lfm-3-1.7b:free` creates a milk todo, the harness toggles the
card, checks the saved task is done, and captures `tool-card-2.png`.

`chat_sharing_owner_and_guest_desktops` runs an owner and a guest desktop on one
server with `--share` and an offline streaming model. Add `TK_CAPTURE_DIR` to save
`mp-owner-share.png` (share picker) and `mp-guest.png` (guest view mid-run).

## Remote profile

Redeem an invite without opening a window:

```sh
target/debug/tokamak-desktop join "tokamak://join?server=wss://host/ws&code=…" --name Sam
target/debug/tokamak-desktop     # connect using the saved remote profile
target/debug/tokamak-desktop leave
```

The same application data directory (or `TOKAMAK_SERVER_DIR`) holds `remote.json`
with the server URL, member ID and bearer token. This private regular file is
created with mode 0600 and takes precedence over local `server.json` discovery.
Remote profiles allow `wss://` hosts; unencrypted `ws://` requires a loopback IP.
Invite endpoints must use `/ws` without credentials, query or fragment. Join uses
`/join` on the same origin over HTTPS (HTTP for loopback), without redirects.
Names must have 1–32 characters and no control characters. `leave` removes the
saved profile; restart an open desktop window to use the changed profile.
