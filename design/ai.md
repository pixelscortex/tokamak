# AI

Puts agents into chat threads. It has no screen of its own: everything it
draws goes into chat's parts. Agents (`claude`, `codex`) give it only data
(name, mark, models, reports) through the `agent` contract.
Paper page: `App 1:1 · AI plugin`: chat's open thread as the base, then each
screen as the app draws it with every plugin on (code's branch chip, layout
control and change card show too). Nothing is drawn on top of the artboards;
the table under "What it adds to others" says which artboard shows each part.

## Screens

All of these are chat screens with ai's parts in them. The client draws them
when the caller has a Runner. Caller actions discover agents, run turns and handle controls.
When a Send has a folder and a resolved agent but its turn start returns `noMachine`,
the status line on the right of the composer’s agent row says “Connect a machine to run this.”
Plain chat Send does not show this line.

| Screen                                                                                         | Source                                                              | Paper artboard              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------- |
| Base: chat's open thread without this plugin (a copy of `Chat · open thread`)                  | `plugins/chat`                                                      | `Base · Chat · open thread` |
| New thread: agent heading, agent row                                                           | `plugins/ai/src/client/ui/heading.tsx`, `ui/agent-row.tsx`          | `AI · new thread`           |
| Reply while the turn runs: work line with the step and clock, Stop, thread status              | `ui/reply-work.tsx`, `ui/turn-controls.tsx`, `ui/thread-status.tsx` | `AI · reply running`        |
| Reply after the turn: reply header, "Worked · 5 actions", helper row, text, tasks, plan, usage | `ui/reply-header.tsx`, `ui/reply-work.tsx`, `ui/reply-cards.tsx`    | `AI · reply finished`       |
| Thinking and the actions line opened                                                           | `ui/reply-work.tsx`                                                 | `AI · reply opened`         |
| Reply with steers: each follow-up drawn where it arrived in the text, as the person's message  | `ui/turn-steers.tsx`, `lib/steers.ts`                               | `AI · reply steered`        |
| Permission question on the composer (Ask first)                                                | `ui/permission-card.tsx`                                            | `AI · permission question`  |

Not drawn yet: the thread list after several turns (its status icons show on the other artboards), the agent row's lines ("Codex isn't installed.", signed out,
"Only Sam can run the agent here"), a picker menu open, a pending steer, queued messages, the
expired question line, "Force stop".

## Parts it offers

None. `ai` publishes no `component`. Agents add to it only through data in
`plugin:ai/contracts` (`agent.name`, `agent.icon`, `info.models`,
`info.speeds`, `info.modes`, and the reports of each turn).

## What it adds to others

All actions are in `plugins/ai/src/client/api.ts`.

| Target (chat part)    | Action                                 | What is drawn                                                                                                                            | File                     | Paper artboard                                                                |
| --------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `Composer.box`        | after                                  | Agent row: agent (mark and name), model, level, speed, mode, permission level; a line on the right ("esc to stop")                       | `ui/agent-row.tsx`       | all five `AI ·` artboards                                                     |
| `Composer.top`        | prepend, while a question waits        | Permission card: lock, "Fake agent wants to run", the command in mono, Approve / Always allow this session / Decline / Cancel (keys 1–4) | `ui/permission-card.tsx` | `AI · permission question`                                                    |
| `Composer.sendButton` | replace, while this window's turn runs | Stop (then Force stop after 10 s)                                                                                                        | `ui/turn-controls.tsx`   | `AI · reply running`, `AI · permission question`                              |
| `Empty.heading`       | replace                                | "What should Fake agent work on?" (the agent's name)                                                                                     | `ui/heading.tsx`         | `AI · new thread`                                                             |
| `Message.header`      | replace, agent replies                 | Agent mark and the model ("work" for the test agent), no time                                                                            | `ui/reply-header.tsx`    | `AI · reply running`, `reply finished`, `reply opened`, `permission question` |
| `Message.body`        | before, agent replies                  | Thinking (quiet, folded), the actions line (folded, 32 px on the hover tone, at least 360 wide), one row per helper agent                | `ui/reply-work.tsx`      | `AI · reply running`, `reply finished`; opened in `AI · reply opened`         |
| `Message.body`        | after, agent replies                   | Tasks card, plan card, usage line (left out when the agent counted 0 in and 0 out)                                                       | `ui/reply-cards.tsx`     | `AI · reply running` (tasks), `reply finished`, `reply opened`                |
| `Message.body`        | replace, agent replies with steers     | The text cut where each steer arrived; between the parts "↳ Steer" (quiet label), then the person's author line and text                 | `ui/turn-steers.tsx`     | `AI · reply steered`                                                          |
| `ThreadRow.status`    | prepend                                | Status icon: running, needs you (amber lock), done, failed                                                                               | `ui/thread-status.tsx`   | `AI · reply running`, `reply finished`, `reply opened`, `permission question` |
| `ThreadRow.detail`    | append, while running or waiting       | Agent mark, model in mono, folder                                                                                                        | `ui/thread-status.tsx`   | `AI · reply running`, `AI · permission question`                              |
| `ThreadRow.detail`    | after, while helpers run               | Half rows, one per helper agent                                                                                                          | `ui/thread-status.tsx`   | `AI · reply running`                                                          |

Where a steer goes: when it is recorded, the server keeps the length of the
reply's stored text (`turns.steerOffsets`, parallel to `steers`). The reply
splits its text there, trims the blank line around the split, and never
splits inside a code fence (a steer sent inside one moves after the fence's
closing line). A steer still on its way to the agent shows at the end of the
text so far. Turns stored before offsets draw their steers after the text,
in the same look. Replies without steers keep chat's own body.

It also turns chat's Send off with `holdSend` while the thread's agent is
missing or signed out, and listens to `onSent` / `onDraftSubmit`.

## If you change X, check Y

- The agent row's height (`h-8`) or its missing start padding: chat's
  composer tray (gap 4, 4 px edge) must still frame it; the row's first
  button edge sits on the box edge above it.
- `Picker` (the ghost `Menu.Trigger`): Button's `md` size owns its height and
  padding; changing Button's ghost look changes the whole row.
- The permission card padding (`py-1 ps-3 pe-1`): chat's `Composer.top`
  gap and the box below it.
- The reply header (`h-5`, mark 14 px, model in `text-data`): chat's
  `Message.header` height; the user's header uses the same 20 px line.
- Work lines and cards (`max-w-read` 560, `min-w-fold` 360): chat's message
  column (760) and `code`'s change card, which spans the full column.
- The steered body (`ui/turn-steers.tsx`) repeats chat's body text style
  (`text-read`, `whitespace-pre-wrap`, `max-w-read`) and chat's author line
  (avatar 18, name in `text-label text-ink-3`, `h-5`); change those in chat
  and change them here. Its pieces sit 16 apart (`gap-4`), and a steer
  has `py-2` more on each side (24 between it and the agent's text).
- `ReplyCards` relies on chat's `Message` gap (8) plus its own `pt-2` for the
  16 px between text and card; changing either changes the other.
- Status icon size (16) and the detail line: chat's `ThreadRow` lead lane
  (`w-4`) and its double-row height.
- `AgentMark` (paths only, painted in currentColor): the marks `claude` and
  `codex` ship must stay single-colour paths.

## Primitives used

`Avatar` (steers), `Button`, `Collapsible` (Thinking uses its `quiet` trigger), `Icon`, `icons`, `Kbd`, `Menu`, `rowVariants`,
`StatusIcon`, `Tooltip`; its own `AgentMark` and `Spinning`.

## Open questions

- The Paper copy uses the test agent ("Fake agent", models named after
  replays such as "work"). Real agents show their own names and models.
