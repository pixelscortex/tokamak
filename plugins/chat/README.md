# Chat

Chat stores threads, messages, and runs. Every answer comes from an installed
`chat.backend` provider; today the ACP plugin connects Claude Code and Codex.
See the root [quick start](../../README.md#quick-start) and
[ACP setup](../acp/README.md) for agent configuration.

## Backend contract

Chat discovers providers through `ctx.providers("chat.backend")`. Each provider
exports `backend:describe`, `backend:configure`, and `backend:turn`; their shared
TypeScript contract is in `backends.ts`. Configure validates provider-specific
settings. Turn receives the thread, run, response message, text, complete prior
conversation, settings, and optional saved session state. Chat keeps this history
for providers that need to seed a fresh agent session.

New threads select the first available provider option. Thread creation is an
action so discovery happens outside a database transaction. With no available
agent, sending fails with "No agent configured: see agents.example.toml" before
creating messages or a run. Cmd+M lists only provider options and configures the
selected agent's folder. Threads preserve session state when the same backend
and settings are selected again.

## Persistence and lifecycle

- Threads contain a title, timestamps, and optional provider backend/settings/state.
- Messages contain ordered text, tool, plan, and permission parts, with status and
  optional bounded error text. Generic tool parts render as dim activity lines
  with expandable details.
- Runs track streaming, cancellation, heartbeats, permission waiting, and recovery.
- `send:start` atomically inserts a user message, assistant placeholder, and run;
  it refuses concurrent sends. `send:update` persists buffered text and generic
  part updates. Provider failures settle the run and unfinished parts.
- `stream-buffer.ts` batches text and polls cancellation/heartbeats while the
  provider waits. Permission handling retains claim/delivery semantics.
- Recovery uses three unchanged observations from one sweeper, independent of
  wall-clock age. Heartbeats protect healthy runs. Recovered messages and parts
  settle with "Interrupted"; the thread can receive another turn.

`threads:create`, `threads:list`, `threads:rename`, and `threads:remove` manage
threads; removal cascades to messages and runs. `threads:setBackend` is private
to chat clients. Public provider functions include `chat:send`, `send:update`,
`send:running`, `send:session`, and permission request/claim/state functions.

## Verification

Run `moon run app:check app:test` and `cargo test -p server`. Server tests cover
thread CRUD, generic part validation, recovery, missing providers, ACP streaming,
permissions, cancellation, and session restoration. See ACP's README for optional
real-agent smoke tests.

Backend writes require a per-turn capability generated in chat's send action.
The selected provider receives it; run queries never return it. Text/part updates,
session saves, and permission request/claim/undelivered writes validate it against
the active run. Completion, cancellation, and recovery revoke the token.
