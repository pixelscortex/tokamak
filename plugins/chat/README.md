# Chat backend

Threads own messages and runs. Clients subscribe to `messages.list` to observe
the same persisted response text, flushed roughly every 100 ms. Parts are arrays
of `{ type: "text", text: string }`, ready for additional part types later.
This follows the thread/message boundary in [Convex Agent](https://github.com/get-convex/agent/blob/main/src/component/schema.ts),
using ordinary message patches rather than a separate stream delta table.

Build with `proto run bun -- packages/build/src/build.ts plugins/chat`.
The app's normal bundle task builds Chat alongside Todo; the server discovers
both from the workspace `plugins/` installation. This plugin has no UI.
Generated references are in `backend/_generated/api.ts` (`api.threads.list`, etc.).

Set `OPENROUTER_API_KEY` in the server process environment or the workspace's
ignored `.env.local`. `OPENROUTER_BASE_URL` optionally overrides
`https://openrouter.ai/api/v1`. The model is `openrouter/free`; `backend/model.ts`
is the single provider boundary. For another host, also change the manifest's
`net:<host>` grant and bump the plugin version. Request arguments cannot supply
credentials or select a network grant.

## UI calls

All functions use one argument object. Wire names and results:

| Kind | Name | Args | Result |
| --- | --- | --- | --- |
| Query | `chat/threads:list` | `{}` | `Thread[]`, newest updated first |
| Query | `chat/messages:list` | `{threadId}` | `Message[]`, oldest first |
| Query | `chat/runs:active` | `{threadId}` | `Run \| null` |
| Mutation | `chat/threads:create` | `{title?: string}` | thread ID |
| Mutation | `chat/threads:rename` | `{threadId, title: string}` | `null` |
| Mutation | `chat/threads:remove` | `{threadId}` | `null` |
| Mutation | `chat/runs:cancel` | `{runId}` | `null` |
| Action | `chat/chat:send` | `{threadId, text: string}` | `{runId, messageId, status: "done" \| "error" \| "cancelled"}` |

Documents include `_id: string` and `_creationTime: number`, plus:

- `Thread`: `ownerId: string`, `title`, `createdAt`, `updatedAt`.
- `Message`: `threadId`, `authorId: string`, `role: "user" | "assistant"`, `parts`,
  `status: "streaming" | "complete" | "error" | "cancelled"`, optional `error`, `createdAt`.
- `Run`: `threadId`, `messageId`, `status: "running" | "done" | "error" | "cancelled"`,
  `startedBy: string`, optional `cancelledBy: string`, `model`, `startedAt`,
  optional `finishedAt` (present for terminal runs).

`Thread.ownerId`, user `Message.authorId`, and `Run.startedBy` are currently
`"owner"`; assistant `Message.authorId` is `"assistant"`. `runs:cancel` sets
`Run.cancelledBy` to `"owner"` when cancelling a running run. The shared `OWNER`
constant becomes the host's member id when threads are shared.

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

No durable recovery, scheduler, retries, auth, multi-user isolation, tools,
embedded UI, or ACP client is included. A host shutdown/reload can leave a run
marked running; there is intentionally no recovery worker.

Offline integration tests run in `cargo test -p server`. The ignored
`chat_real_openrouter_smoke` test is a manual real-provider check with `.env.local`:
`cargo test -p server --test actions chat_real_openrouter_smoke -- --ignored --nocapture`.
