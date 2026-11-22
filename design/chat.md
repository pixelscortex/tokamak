# Chat

Threads, messages, the composer and the folder a thread works in. Chat knows
nothing about agents or code; `ai` and `code` add to its parts.
Paper page: `App 1:1 · Chat plugin`.

## Screens

| Screen                                                             | Source                                                                    | Paper artboard               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------- |
| New thread: icon, "Start a conversation", folder choices, composer | `plugins/chat/src/client/pages/chat.tsx` (`NewThread`), `ui/empty.tsx`    | `Chat · new thread`          |
| New thread with text in the composer (Send filled)                 | `ui/composer.tsx`                                                         | `Chat · typing`              |
| Open thread: header, messages, composer                            | `pages/chat.tsx` (`OpenThread`), `ui/message.tsx`, `ui/thread-header.tsx` | `Chat · open thread`         |
| Thread menu open (Rename, Delete thread)                           | `ui/thread-header.tsx` (`ThreadMenu`)                                     | `Chat · thread menu`         |
| Thread list in the sidebar ("New thread ⌘N", then threads)         | `ui/thread-list.tsx`                                                      | shown on every chat artboard |

Not drawn yet: the "Choose a folder" dialog, the delete dialog, a failed or
stopped reply line ("Stopped", "Failed · …"), a queued message (dashed box).

## Parts it offers

Other plugins import these from `plugin:chat/client` and act on them with
`before`, `after`, `prepend`, `append`, `wrap`, `replace` or `hide`
(`packages/build/README.md`, "Extending a component"). Every action gets the
component's props. The list of paths is generated in
`plugins/chat/src/client/_generated/components.d.ts`.

| Part                                                                   | File                   | What may go there                                                                                       |
| ---------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `Composer.top`                                                         | `ui/composer.tsx`      | Inside the tray, above the box: a card that needs the person (permission question). Hidden while empty. |
| `Composer.box`                                                         | `ui/composer.tsx`      | The prompt and Send on the card tone. Siblings after it sit in the same tray (agent row).               |
| `Composer.input`                                                       | `ui/composer.tsx`      | The text field.                                                                                         |
| `Composer.tools`                                                       | `ui/composer.tsx`      | Small controls left of Send. Hidden while empty.                                                        |
| `Composer.sendButton`                                                  | `ui/composer.tsx`      | Send. May be replaced (Stop).                                                                           |
| `Message.avatar`, `Message.header`                                     | `ui/message.tsx`       | The author line: avatar, name, time. May be replaced (agent reply header).                              |
| `Message.body`                                                         | `ui/message.tsx`       | The text. Before it: work lines; after it: cards.                                                       |
| `Message.footer`                                                       | `ui/message.tsx`       | Under the message. Hidden while empty (change card, notices).                                           |
| `Empty.icon`, `Empty.glyph`, `Empty.heading`, `Empty.folders`          | `ui/empty.tsx`         | The new thread's mark, heading (may be replaced) and folder choices.                                    |
| `ThreadRow.row`, `status`, `title`, `age`, `detail`                    | `ui/thread-list.tsx`   | `status` is the 16 px lane before the title; a filled `detail` makes the row a double row.              |
| `Header.icon`, `title`, `titleInput`, `folder`, `menu`, `deleteDialog` | `ui/thread-header.tsx` | After `title`: chips. Before `menu`: controls.                                                          |

Other hooks (not drawn): `holdSend` turns Send off in a composer, `onSent`
announces each Send, `onDraftSubmit` handles a draft before Send.

Chat fills the shell's `Region.Sidebar` (thread list) and `Region.Header`
(thread header) from `pages/chat.tsx`.

## What it adds to others

| Target                 | What                                                                      | File                        |
| ---------------------- | ------------------------------------------------------------------------- | --------------------------- |
| Shell `sidebar` region | The thread list                                                           | `pages/chat.tsx`            |
| Shell `header` region  | The open thread's header; the page title "New thread" or the thread title | `pages/chat.tsx`            |
| Shell rail             | Its view mark                                                             | `lib/icons.ts` (`chatIcon`) |

## If you change X, check Y

- The composer tray (`nest-lg/1 surface-tray`, gap 4) or the box padding
  (`py-3 ps-4 pe-3`): `ai` agent row (no start padding, so its first button
  sits on the box edge), `ai` permission card (`ps-3 pe-1` on the tray), `ai`
  Stop button (same size as Send).
- The message column width (`max-w-thread` 760, `px-8`) or the composer
  column: `code` change card (full width of the column), `ai` work lines and
  cards (`max-w-read` 560), the new thread's composer (same column on purpose).
- `Message` spacing (`gap-2`, `pb-12`) or the header height (`h-5`): `ai`
  reply header (also `h-5`), `ai` cards (`pt-2`, relies on the 8 px gap),
  `code` change card and notices in `footer`.
- `ThreadRow` box (`min-h-8`, `px-row`, `py-1`) or the lead lane (`w-4`):
  `ai` status icon, detail line and helper rows (half rows start at the title edge).
- The header layout (`gap-2`, chip after the title, `flex-1` before the menu):
  `code` branch chip (`ms-2`), layout control and review panel mount.
- The empty state heading style (`text-read font-semibold`): `ai`
  `AgentHeading` repeats it and must match.
- Removing or renaming any part: every action on it in `ai` and `code`
  breaks at build time; update `design/ai.md` and `design/code.md`.

## Primitives used

`Button`, `Avatar`, `Chip`, `Dialog`, `Icon`, `Kbd`, `Menu`, `Row`, `RowList`,
`rowVariants`, `ScrollArea`, `StatusIcon`, `Textarea` (dialog only; the
composer uses the bare ui-sdk textarea), the `surface-*`, `nest-*`,
`density-*` and `focus-ring` utilities.

## Open questions

- The README's component table lists `Composer.tools`, but no plugin fills it yet.
- `Message.avatar` comes from the `<Avatar>` tag's name (a tag publishes its
  own name), not from a `part`; replacing it also needs care with the header's
  `h-5` line. No plugin acts on it yet.
