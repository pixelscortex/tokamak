# Chat backend

Threads own messages and runs. Clients subscribe to `messages.list` to observe
the same persisted response text, flushed roughly every 100 ms. Parts contain text and persisted tool calls.
Live queries deliver current snapshots and can coalesce intermediate commits;
a fast tool may already be settled in its first visible snapshot.
This follows the thread/message boundary in [Convex Agent](https://github.com/get-convex/agent/blob/main/src/component/schema.ts),
using ordinary message patches rather than a separate stream delta table.

Build with `proto run bun -- packages/build/src/build.ts plugins/chat`.
The app's normal bundle task builds Chat alongside Todo; the server discovers
both from the workspace `plugins/` installation. This plugin has no UI.
Generated references are in `backend/_generated/api.ts` (`api.threads.list`, etc.).

Set `OPENROUTER_API_KEY` in the server process environment or the workspace's
ignored `.env.local`. `OPENROUTER_BASE_URL` optionally overrides
`https://openrouter.ai/api/v1`. The default model is `openrouter/free`; each thread can select a model from
`models.ts`. `backend/model.ts`
is the single provider boundary. For another host, also change the manifest's
`net:<host>` grant and bump the plugin version. Request arguments cannot supply
credentials or select a network grant.

Native UI consumers import `api` from `plugins/chat/client.ts`. It uses the same
SDK references and wire names without importing the action provider's Web API
ambient types into the QuickJS UI type graph.

## UI calls

All functions use one argument object. Wire names and results:

| Kind | Name | Args | Result |
| --- | --- | --- | --- |
| Query | `chat/threads:list` | `{}` | `Thread[]`, newest updated first |
| Query | `chat/messages:list` | `{threadId}` | `Message[]`, oldest first |
| Query | `chat/runs:running` | `{}` | `{runId, threadId, model, waiting, startedBy, starterName}[]`, visible running runs |
| Query | `chat/runs:active` | `{threadId}` | `Run \| null` |
| Mutation | `chat/threads:create` | `{title?: string}` | thread ID |
| Mutation | `chat/threads:rename` | `{threadId, title: string}` | `null` |
| Mutation | `chat/threads:setBackend` | `{threadId, backend}` | `null` |
| Action | `chat/agents:list` | `{}` | `{id, title}[]` |
| Mutation | `chat/threads:setModel` | `{threadId, model: string}` | `null` |
| Mutation | `chat/threads:remove` | `{threadId}` | `null` |
| Mutation | `chat/runs:recover` | `{}` | `null` |
| Mutation | `chat/permissions:answer` | `{messageId, requestId, optionId}` | `null` |
| Mutation | `chat/runs:cancel` | `{runId}` | `null` |
| Action | `chat/chat:send` | `{threadId, text: string}` | `{runId, messageId, status: "done" \| "error" \| "cancelled"}` |

A text part is `{type: "text", text: string}`; tool parts are described below.

Documents include `_id: string` and `_creationTime: number`, plus:

- `Thread`: `ownerId: string`, `title`, `createdAt`, `updatedAt`, optional `model` (defaults to `openrouter/free`).
- `Message`: `threadId`, `authorId: string`, optional `authorName: string` and `authorRole: "owner" | "guest"`, `role: "user" | "assistant"`, `parts`,
  `status: "streaming" | "complete" | "error" | "cancelled"`, optional `error`, `createdAt`.
- `Run`: `threadId`, `messageId`, `status: "running" | "done" | "error" | "cancelled"`,
  `startedBy: string`, optional `cancelledBy: string`, `model`, `startedAt`,
  optional `updatedAt` (heartbeat), `error`, and `finishedAt` (present for terminal runs).

## Sharing

The host supplies `ctx.caller = {memberId, name, role}` on every call. Thread
ownership, user message authors, run starters, cancellations and permission
answers record the caller's member ID. User messages also store `authorName`;
assistant messages retain `authorId: "assistant"`.

Call `chat/members:hello {}` on connect to upsert the caller's name and last-seen
time; it returns the server's `{memberId, name, role}` for the connection, which
the desktop uses to choose owner or guest controls. The owner can query
`chat/members:list {}` and `chat/threads:shares {}` (every `{threadId, memberId}`
share, for Map counts and the share picker) and share or unshare with
`chat/threads:share {threadId, memberId}` and
`chat/threads:unshare {threadId, memberId}`. Shares are idempotent and thread
deletion removes them. `shares` indexes membership and threads; `members` stores
only member IDs, display names and last-seen timestamps, with no credentials.

Owners see every thread. Guests see shared threads only, including their live
messages and running runs. Unsharing removes the thread and its messages from
live subscriptions. Guests can watch ACP threads but can send only to model
backends. Their sends use the owner's selected model and key, with no tools,
at most 20 runs per rolling hour and 100 per rolling day per member, and a
16 KB UTF-8 text limit. Model history keeps owner turns plain and always marks
guest turns as untrusted, using their stored author identity even after unsharing.
Owner-started model runs in any thread with a guest-authored message require
approval before every tool call, including after unsharing. Each call shows an
inline permission with the plugin, tool and a short argument summary. Allow runs
that call once; Deny or a 30-minute timeout returns `The owner declined this tool call`
to the model and marks the tool as an error. Cancellation stops the run and marks
the pending call with the same declined error. Only the owner can answer.
Threads without guest messages run tools without prompts; ACP permissions keep
their existing behavior.
`members:hello` rejects guest names equal to "owner" case-insensitively.

`runs:running` names each run's starter from `members` (falling back to `Owner`
or `Guest`), so every viewer can label the busy strip.

Only `threads:list`, `messages:list`, `runs:running`, `runs:active`, `chat:send`,
`runs:cancel`, `runs:recover` and `members:hello` accept guest wire calls. Guests
may cancel only their own runs in visible threads; the owner may cancel any run.
Guests cannot create, rename or remove threads, change models or backends,
list agents, share threads, list members, or answer permissions.

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

No scheduler, retries, or embedded UI is included. Host authentication and
per-thread sharing govern access.
There is no plugin initialization hook today. Recovery is
lazy: `send.start` checks stale runs before admitting a new reply; the native
client calls `runs:recover` on observing running runs and every 30 seconds while
they exist (queries themselves remain read-only). Actions heartbeat every 10
seconds, including while waiting for HTTP headers or silent streams. Runs with
no update for 60 seconds become `error` with `error: "Interrupted"`; their response
messages also become `error` with `error: "Interrupted"`. Legacy runs without
`updatedAt` use `startedAt`. Terminal runs are left alone. Recovery uses ordinary
transactions and does not resume or retry work; durable runs (TKM-103) remain out
of scope.

Offline integration tests run in `cargo test -p server`. The ignored
`chat_real_openrouter_smoke` test is a manual real-provider check with `.env.local`:
`cargo test -p server --test actions chat_real_openrouter_smoke -- --ignored --nocapture`.

## Native chat controls

Enter sends, Shift+Enter inserts a line, and whitespace-only messages are ignored.
During a run the strip shows `REPLYING · <starter>` and the composer stays typeable
with muted text; Enter leaves the draft alone. If another member's send wins a
race, the draft is kept and the strip shows `Busy: <name> just sent`. Escape stops
the run only for its starter or the owner.

User messages from another member show their name above the text. The owner
opens the share picker with Cmd+Shift+S: arrows move, Enter shares or unshares
the open thread with a member, Escape closes; with nobody joined it explains
`tokamak member invite`. The owner's Map shows `· N` after shared threads.
Guests see only shared threads and no rename, delete, new thread, backend or
share controls; the server refuses those calls regardless. Tab opens Map. With an empty search, R renames the
selected row inline (Enter saves, Escape cancels). Cmd+Backspace asks
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

## ACP backend

Threads optionally store `backend: {kind:"model", model}` or
`{kind:"acp", agent, cwd, sessionId?}`. An absent backend uses the existing
`model` field and default model without migration. `threads:setBackend` preserves
an existing session only when agent and cwd match; callers cannot inject sessions.
`threads:setModel` selects the model backend. The plugin declares the `acp` grant;
configure permitted agents in the host data directory's `agents.toml` with
`plugins = ["chat"]`. `agents:list` is an action because ACP is action-only.

ACP opens and saves a session before prompting. Restored sessions receive only
the new user text; fresh sessions also receive the most recent flattened completed
history, capped at 32 KB. Runs identify their backend as `acp:<agent>`.
Text uses the same ordered persistence and 100 ms buffer as model replies.
Non-text message content becomes `[image]` or `[resource]`. Tools use
`plugin:"acp:<agent>"`, retain ACP call IDs and follow the existing size limits.
Plans use `{type:"plan", entries:[{content, status, priority}]}`; each update
replaces the message's single plan part. Other updates, including thoughts, are ignored.

Normal completion and token/turn limits finish successfully (limits append a
short note); refusals persist `Agent refused`. Cancellation stops the agent and
settles running tools with `error:"cancelled"`. Authentication errors while
opening suggest signing in to the agent in a terminal. Permission requests flush text and persist an inline `permission` part with the request
and call IDs, title, options, and `pending`, `answered`, `expired`, or `cancelled`
status. The run sets `waiting` while polling for an answer; heartbeats continue.
Only the run starter or thread owner may answer, and the first valid option wins.
Answers record `optionId` and `answeredBy`. These mutations are not plugin exports.
After 30 minutes the request expires and ACP receives cancelled; stopping a run
cancels its pending permission, and stale recovery expires it.

Map groups waiting threads under NEEDS YOU above RUNNING. Permission options appear
inline with allow options first. With an empty composer, 1–4 answers the latest
pending request. Answered rows show the chosen option dimmed; expired and cancelled
rows show their status.

## Configuring real agents

Copy [`agents.example.toml`](../../agents.example.toml) to `agents.toml` in the
Tokamak data directory: `$TOKAMAK_SERVER_DIR` when set, otherwise
`~/Library/Application Support/com.pixelscortex.Tokamak` on macOS
(`$XDG_DATA_HOME/tokamak` or `~/.local/share/tokamak` on Linux).
Agents are loaded once at startup; restart the app (server) after editing `agents.toml`.
The pinned Claude and Codex adapters require Node.js/npx. Only named `env`
variables are passed through, including `PATH` for npx and its Node interpreter.
Set API keys in the server environment or `.env.local` in the parent of the
plugin installation directory (the repository root when using workspace `plugins/`).
Prefer API keys: subscription logins in third-party apps may break provider terms.
Agents have the same access as their CLI; the selected folder is not a sandbox.

Manual credentialed checks (never part of the normal suite): set
`TOKAMAK_ACP_AGENTS` to the absolute path of a real `agents.toml` with the relevant
`claude` / `codex` entry allowing `chat`. Each test uses a temporary copy of this
repo's tracked files and refuses permission requests.

```sh
TOKAMAK_ACP_AGENTS=/absolute/path/agents.toml cargo test -p server --test acp acp_real_claude_smoke -- --ignored --exact --nocapture
TOKAMAK_ACP_AGENTS=/absolute/path/agents.toml cargo test -p server --test acp acp_real_codex_smoke -- --ignored --exact --nocapture
```
