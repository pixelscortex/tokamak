# Chat backend

Threads own messages and runs. Clients subscribe to `messages.list` to observe
the same persisted response text, flushed roughly every 100 ms. Parts contain text and persisted tool calls.
Live queries deliver current snapshots and can coalesce intermediate commits;
a fast tool may already be settled in its first visible snapshot.
This follows the thread/message boundary in [Convex Agent](https://github.com/get-convex/agent/blob/main/src/component/schema.ts),
using ordinary message patches rather than a separate stream delta table.

Build with `proto run bun -- packages/build/src/build.ts plugins/chat`.
The app's normal bundle task builds the bundled plugins; the server discovers
them from the workspace `plugins/` installation. This plugin has no UI.
Generated references are in `backend/_generated/api.ts` (`api.threads.list`, etc.).

Set `OPENROUTER_API_KEY` in the server process environment or the workspace's
ignored `.env.local`. `OPENROUTER_BASE_URL` optionally overrides
`https://openrouter.ai/api/v1`. The default model is `openrouter/free`; each thread can select a model from
`models.ts`. `backend/model.ts`
is the single provider boundary. For another host, also change the manifest's
`net:<host>` grant. Request arguments cannot supply
credentials or select a network grant.

Native UI consumers import `api` from `plugins/chat/client.ts`. It uses the same
SDK references and wire names without importing the action provider's Web API
ambient types into the QuickJS UI type graph.

## UI calls

All functions use one argument object. Wire names and results:

| Kind     | Name                      | Args                               | Result                                                         |
| -------- | ------------------------- | ---------------------------------- | -------------------------------------------------------------- |
| Query    | `chat/threads:list`       | `{}`                               | `Thread[]`, newest updated first                               |
| Query    | `chat/messages:list`      | `{threadId}`                       | `Message[]`, oldest first                                      |
| Query    | `chat/runs:running`       | `{}`                               | `{runId, threadId, model, waiting}[]`, running runs            |
| Query    | `chat/runs:active`        | `{threadId}`                       | `Run \| null`                                                  |
| Mutation | `chat/threads:create`     | `{title?: string}`                 | thread ID                                                      |
| Mutation | `chat/threads:rename`     | `{threadId, title: string}`        | `null`                                                         |
| Mutation | `chat/threads:setBackend` | `{threadId, backend}`              | `null`                                                         |
| Action   | `chat/backends:list`      | `{}`                               | `{id, title, plugin, folder?}[]`                               |
| Mutation | `chat/threads:setModel`   | `{threadId, model: string}`        | `null`                                                         |
| Mutation | `chat/threads:remove`     | `{threadId}`                       | `null`                                                         |
| Mutation | `chat/runs:observe`       | `{sweepId: string, tick: number}`  | `null`                                                         |
| Mutation | `chat/permissions:answer` | `{messageId, requestId, optionId}` | `null`                                                         |
| Mutation | `chat/runs:cancel`        | `{runId}`                          | `null`                                                         |
| Action   | `chat/chat:send`          | `{threadId, text: string}`         | `{runId, messageId, status: "done" \| "error" \| "cancelled"}` |

A text part is `{type: "text", text: string}`; tool parts are described below.

Documents include `_id: string` and `_creationTime: number`, plus:

- `Thread`: `title`, `createdAt`, `updatedAt`, optional `model` (defaults to `openrouter/free`).
- `Message`: `threadId`, `role: "user" | "assistant"`, `parts`,
  `status: "streaming" | "complete" | "error" | "cancelled"`, optional `error`, `createdAt`.
- `Run`: `threadId`, `messageId`, `status: "running" | "done" | "error" | "cancelled"`,
  `model`, `startedAt`,
  optional `updatedAt` (heartbeat timestamp), `heartbeat` (counter), `error`, and `finishedAt` (present for terminal runs).

The shell uses one `runs:running` subscription for Map grouping and active-run state,
regardless of thread count. This query uses the runs `by_status` index.

IDs are SDK table IDs; timestamps are epoch milliseconds. Empty titles/text are
refused. Only one run may be active per thread; another send is refused. The
first user message replaces the default title `New thread` (up to 80 characters).
Completed messages form model history. Error/cancelled responses remain visible
but are excluded from future model history. Upstream/configuration failures
return `status: "error"` and persist a readable `Message.error`; invalid input,
a missing thread, or an already active run rejects the action before starting.

Cancel is idempotent and marks both records immediately. The action checks the
run between chunks and every 100 ms during silence, then aborts HTTP. Deleting
a thread cascades through messages and runs; its in-flight action also stops.
The `send:*` transaction steps are implementation details excluded from the
cross-plugin export surface; use `chat:send` to send messages.

No scheduler, retries, or embedded UI is included. The local owner token governs
access for the single owner.
There is no plugin initialization hook today. The owner's desktop starts a sweep
on launch when running runs are observed, then calls the owner-only `runs:observe`
mutation every 30 seconds on its own timer while runs exist. Each sweep has a
unique `sweepId` and increasing `tick`. Three consecutive observations with an
unchanged heartbeat counter interrupt a run (at least 60 seconds between the
first and third). Each sweeper keeps its own streak; a heartbeat change resets
that streak to zero. Duplicate and older ticks are ignored. At most four sweepers
are retained per run, evicting the one with the oldest tick.
Actions heartbeat every 10 seconds, including while waiting for HTTP headers,
silent streams, tools, or permissions. Recovery never waits inside an action
and never uses wall-clock age to decide liveness. A send encountering a running
run returns the busy error until that run finishes or the sweep interrupts it.
A dead run clears within about 90 seconds while the owner's app is open;
otherwise it clears on the next launch, after the sweep's observation window.
Abandoned runs, including legacy runs without a counter, become `error` with
`error: "Interrupted"`; their messages, tools, and pending permissions settle too.
Terminal runs are left alone. Recovery does not resume or retry work; durable
runs (TKM-103) remain out of scope.

Offline integration tests run in `cargo test -p server`. The ignored
`chat_real_openrouter_smoke` test is a manual real-provider check with `.env.local`:
`cargo test -p server --test actions chat_real_openrouter_smoke -- --ignored --nocapture`.

## Native chat controls

Enter sends, Shift+Enter inserts a line, and whitespace-only messages are ignored.
During a run the strip shows `REPLYING`; Escape stops the run.
Tab opens Map. With an empty search, R renames the selected row inline (Enter saves, Escape cancels). Cmd+Backspace asks
`Delete? Enter / Esc` on that row before removing it and its messages/runs.

Click the backend above the composer or press Cmd+M to open the backend picker.
Use arrows and Enter to select a model or agent; Escape closes it. Agents ask for
an absolute folder path (Enter saves), prefilled with the last used folder.
Switching backends preserves all messages.
An active run retains the model it started with; the next send uses the selection.
The shared list in `models.ts` contains `openrouter/free`,
`inclusionai/ling-3.2-flash:free`, `liquid/lfm-3-1.7b:free`, and
`google/gemma-4-26b-a4b-it:free`. These three `:free` IDs were verified against
`https://openrouter.ai/api/v1/models` on 2026-11-15. Availability can change.

Cmd+Shift+C copies the last assistant reply’s text through the native clipboard
bridge. The composer strip shows `COPIED` briefly after success.

Conversation history uses a bounded native scroller in chronological order.
Layout observations keep the view at the bottom as replies grow while it is
following the newest message. Scrolling more than eight pixels away pauses
following; returning to the bottom resumes it. History stays in normal flow
because Blitz only supports non-negative scroll offsets.

Assistant replies render CommonMark tokens as native Solid elements using
`marked` 18.2.0's lexer, without HTML insertion or browser APIs. At implementation
time, a standalone minified browser lexer bundle measured 49.9 kB (15.1 kB gzip),
versus 87.5 kB (24.5 kB gzip) for `mdast-util-from-markdown` 2.1.0. Marked has no
runtime dependencies; the package's unpacked size includes its CLI, types and maps. User messages
remain plain text. Fences remain code blocks before their closing delimiter
arrives; code uses Space Mono, a neutral background and horizontal scrolling.
Links are underlined text only. HTML is displayed literally, never executed.

## Tools

Chat consumes `chat.tools` and discovers installed providers with `ctx.providers`.
Providers export `tools:describe` and `tools:invoke`, generated by SDK `defineTools`.
`describe({})` returns `{name, description, parameters, view?}[]`, with JSON Schema
parameters. `invoke({name, args, threadId})` validates the arguments and returns
`{result, summary, model?, view?}`. The SDK defaults `model` to serialized `result`
and copies the tool definition’s `view` into the output when present.
Model names sanitize `plugin__toolName` to letters, digits, `_` and `-` (64 characters);
collisions fail rather than routing to the wrong tool. Parts retain real names.

A tool part has `{type:"tool", callId, plugin, toolName, args, status}` with
`status: "running" | "done" | "error"` and optional `result`, `summary`, `model`,
`view`, `error`. Arguments above 16 KB of JSON are rejected before storage or
execution; stored errors stay within 2 KB. Result JSON above 8 KB is replaced by
`{truncated:true}`.
Tool updates flush pending text immediately. Calls execute serially, each in
its provider's transaction; a run stops after at most five model steps.
Tool errors return to the model and persist on the part. Cancellation marks
running parts with `status:"error", error:"cancelled"`; stale recovery settles
them with `error:"Interrupted"`.
Earlier turns flatten tools to `[tool toolName: model text]`; the current run
keeps AI SDK tool messages. Rendering these parts belongs to the desktop.

## Plugin backends

Chat consumes `chat.backend` through `ctx.providers` and host-mediated plugin calls.
The built-in model backend remains the default. Plugins export `backend:describe`,
`backend:configure` and `backend:turn`; see [`backends.ts`](backends.ts) for the types.
Describe returns `{id, title, folder?}[]`; folder opts into the existing folder input.
Configure validates opaque settings before the picker saves them. Turn receives run,
message and thread IDs, a per-turn capability token, backend ID, text, history, settings
and optional provider state. Every backend storage write requires `{runId, token}`
and a running turn. Tokens are private to the delegated turn, omitted from queries,
and cleared on completion, cancellation or recovery.
It streams through the public functions re-exported in `api.ts`: `send:update`,
`send:running`, `send:session` and the permission request/state/claim/undelivered steps.
[`server.ts`](server.ts) supplies finite references; [`stream.ts`](stream.ts) supplies
reusable buffering and permission polling helpers without importing backend handlers.

Threads store `{kind:"model", model}` or
`{kind:"plugin", plugin, backendId, settings?, state?}`. Settings and state are opaque
JSON. Selecting the same provider, option and settings preserves provider state;
changing them clears it. Callers cannot inject state through `setBackend`.
Missing backend plugins finish the run with `error` and a readable message.
There are no backend-field migrations; pre-beta local data may be reset.

Permission parts, first-answer-wins claims, cancellation and recovery belong to
chat. A backend supplies only the callback that delivers the claimed answer.
After 30 minutes a request expires. Stopping cancels pending requests; recovery
expires them. Map and inline permission controls work for every backend.
