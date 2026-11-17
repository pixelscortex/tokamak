# Chat

Chat stores threads, messages, and runs. Every answer comes from an installed
`chat.backend` provider; today the ACP plugin connects Claude Code and Codex.
See the root [quick start](../../README.md#quick-start) and
[ACP setup](../acp/README.md) for agent configuration.

## Backend contract

Chat discovers providers through `ctx.providers("chat.backend")`. Each provider
exports `backend:describe`, `backend:configure`, and `backend:turn`; their shared
TypeScript contract is exported from `src/server/api.ts`. Configure validates provider-specific
settings. Turn receives the thread, run, response message, text, complete prior
conversation, settings, and optional saved session state. Chat keeps this history
for providers that need to seed a fresh agent session.

New threads select the first available provider option. Thread creation is an
action so discovery happens outside a database transaction. With no available
agent, sending fails with "No agents found. Install `claude-agent-acp` or `codex-acp` (see README)" before
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

## Client UI and composer mods

Chat owns its `/` view contribution (`/p/chat` in the shell). The view fills
the shell's regions: the thread list goes in `Region.Sidebar`, the thread's
title, folder and actions in `Region.Header`, and the thread with its composer
is the stage body. Everything is Tailwind classes on `@tokamak/ui` tokens and
primitives; `styles.css` only compiles those utilities, and markdown needs no
stylesheet because each rendered element carries its own classes.

- `src/client/pages/screen.tsx`: the view, shortcuts and the thread pane.
- `src/client/ui/`: `sidebar/` (recent threads), `header/` (rename, copy,
  delete), `thread/` (turns, markdown, the folded work row, the plan list,
  empty and no-agent states) and `composer/`.
- `src/client/lib/`: state (`use-chat`, `use-drafts` with the follow-up queue,
  `use-backends`, `use-run-recovery`, `use-thread-editor`, `chat-keys`),
  `turns.ts` (folding a turn's tools into one summary), `follow.ts` (scroll
  following) and `composer.ts` (the composer API and slots).

Keys: Enter sends and Shift+Enter adds a line; while a reply runs Enter queues
the text as the next turn, Esc stops, and 1–4 answer a permission while the
draft is empty. ⌘N opens a new thread, ⌘M the agent menu, ⌘⇧C copies the last
reply.

The public client entry (`src/client/api.ts`, exposed as `@plugins/chat/ui`)
exports `Composer`, `ComposerInput`, `ComposerStrip` and `SendButton`. Each is
wrappable or replaceable. The default composer shows `SendButton`, which turns
into Stop while a reply runs.

| Token                | Qualified slot              | Position                                 |
| -------------------- | --------------------------- | ---------------------------------------- |
| `composerBefore`     | `chat.composer.before`      | Top of the composer card (context chips) |
| `composerActions`    | `chat.composer.actions`     | Action row, left of send                 |
| `composerStripLeft`  | `chat.composer.strip.left`  | Strip, before the agent picker           |
| `composerStripRight` | `chat.composer.strip.right` | Strip, after the hint                    |
| `composerAfter`      | `chat.composer.after`       | Below the composer                       |

Every fill receives `{ composer: ComposerAPI }`. `threadId()`, `getDraft()`,
`setDraft(text)`, `insertText(text)` (at the caret or selection), `submit()`
and `busy()` share the current thread's draft and run state. Components inside
the view can also call `useComposer()`.

```tsx
import { fill, wrap } from "@tokamak/sdk/client";
import { Button } from "@tokamak/ui";
import { ComposerInput, composerActions, composerStripRight } from "@plugins/chat/ui";
export const Insert = fill(composerActions, { order: 10 }, ({ composer }) => (
  <Button variant="ghost" onClick={() => composer.insertText("Run tests")}>
    Tests
  </Button>
));
export const Status = fill(composerStripRight, {}, () => (
  <span class="text-label text-ink-3">Review mode</span>
));
export const Frame = wrap(ComposerInput, (Original) => (props) => <Original {...props} />);
// Export these from your plugin's src/client/api.ts; no registration step.
```

## Client checks

`proto run bun -- run moon run chat:test` runs the unit tests in `tests/`.
`src/client/tsconfig.json` typechecks the client (part of `workspace:plugins-check`).
`proto run bun -- run e2e:browser` drives the real chat flow in a browser
(`e2e/browser/chat.spec.ts`). For a hands-on look, `proto run bun -- e2e/chat-sandbox.ts`
serves a disposable store with ACP and a scripted agent (`e2e/fixtures/scripted-agent.py`);
HOME and PATH are replaced so no real, billing agent CLI can be launched.
