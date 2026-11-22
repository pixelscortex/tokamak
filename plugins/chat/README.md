# Chat

Chat is pure threads: the thread list, the new thread, the composer, messages,
the folder of a thread and the thread header. It knows nothing about agents,
turns or code. Other plugins (`ai`, `code`) extend its components, learn about
each Send, and write replies through its plugin-only functions.

## What a person sees

Opening the app lands on a new thread: an icon, "Start a conversation", the
recent folders with "Choose a folder…" and "No folder", and the composer.
Nothing is stored until the first Send, which creates the thread and its first
message. "No folder" gives the thread an empty folder of its own under the
app's data, `<app data>/no-project/threads/<thread>`, made by chat's local part.
The list has "New thread ⌘N" on top and one list of threads, newest first.
The header shows the title (double-click renames), the folder, and `⋯` with
Rename and Delete thread.

## Folders

A thread's `folder` is `{ kind: "chosen", path }` or `{ kind: "own", path? }`
("No folder"). It lives on the creator's computer. On the desktop, a typed
folder goes through the local `folders:check` (expands `~`, must exist); a plain
browser stores it as typed. `folders:resolve({ threadId })` (local) returns the
folder ready to use and makes an own folder the first time it is asked for;
only the thread's creator can store it (`threads:setFolder`). On anyone
else's computer it returns null, so their Send stays plain chat. Without the
client's data folder (`TOKAMAK_APP_DATA_DIR`), an own folder is a temporary one
that is not stored.

## Server and local functions

- `threads:start({ text, folder })` creates a thread with its first message and
  returns `{ threadId, messageId }`.
- `threads:list`, `threads:get`, `threads:rename`, `threads:remove` (removes its
  messages too), `threads:recentFolders` (the caller's last three chosen folders),
  `threads:setFolder` (an own folder's path, once, creator only),
  `threads:creator` (`{ id, name? }` of whoever started it, named as on its first
  message; exported as `threadCreator`).
- `messages:list`, `messages:post({ threadId, text })` (returns the message id).
- Plugin-only: `messages:stage` stores a queued message; `messages:deliver`
  puts it into the transcript or marks it failed. `messages:prompt` reads a
  user's message by id. Exported as `stageMessage`, `deliverMessage` and `readPrompt`.
- Plugin-only (no window can call them): `replies:start({ threadId, token, author })`
  opens a reply bound to a 64-hex token the calling plugin chose for its turn;
  `replies:write({ messageId, token, text, done?, outcome?, error? })` replaces its
  text, and only with that token. A finished reply can be cancelled or failed.
  Exported from `src/server/api.ts` as `startReply` / `writeReply`.
- Local: `folders:resolve`, `folders:check`, `threads:removeLocal`. Use them only when
  `client.hasLocal` (a `TokamakClient` getter, true in the desktop client).
  Only the creator can rename or delete a thread. The server calls the
  `threadDeletedServer` providers in the deletion transaction.
  `threads:removeLocal({ threadId })` deletes the thread on the server, then calls
  `threadDeletedLocal` providers from `plugin:chat/contracts` in the local part. Their
  `after({ threadId, folder })` can clean up local data; `folder` may be absent.

Agent runs and permission questions belong to `ai`. Chat stores the thread
and streams replies from plugins through its reply API.

## Extending chat

Import the components through `plugin:chat/client` and act on their elements.
Every action and its `when` receive the component's props.

| Component   | Elements                                                        | Props                                    |
| ----------- | --------------------------------------------------------------- | ---------------------------------------- |
| `Composer`  | `top`, `box`, `input`, `tools`, `sendButton`                    | `threadId`, `folder`, `draft`, `sending` |
| `Message`   | `avatar`, `header`, `body`, `footer`                            | `message`, `threadId`, `next`, `isLast`  |
| `Empty`     | `icon`, `glyph`, `heading`, `folders`                           | `folders`, `folder`                      |
| `ThreadRow` | `row`, `status`, `title`, `age`, `detail` (second line)         | `thread`, `now`                          |
| `Header`    | `icon`, `title`, `titleInput`, `folder`, `menu`, `deleteDialog` | `thread`                                 |

`Message.next` and `isLast` tell where a run of replies ends without chat
knowing about turns. A filled `ThreadRow.detail` makes the row a double row.

`onDraftSubmit` can handle an open thread's draft before normal Send. It
receives `{ threadId, text, intent }`, where intent is `"steer"` for Enter or
`"queue"` for Cmd+Enter / Ctrl+Enter. Return true once handled; otherwise chat
stores it and calls `onSent` as usual. `resolveFolder(client, threadId)` is also
exported for clients starting a staged message.

```tsx
import { onCleanup } from "solid-js";
import { after, append, prepend, replace } from "@tokamak/sdk/client";
import * as chat from "plugin:chat/client";

export const Row = after(chat.Composer.box, AgentRow);
export const Question = prepend(chat.Composer.top, PermissionCard, { when: (c) => waiting(c.threadId) });
export const Card = append(chat.Message.footer, ChangeCard, {
  when: (m) => !m.next || m.next.role === "user",
});
export const Heading = replace(chat.Empty.heading, AgentHeading);
export const Status = append(chat.ThreadRow.status, StatusIcon);
export const Branch = after(chat.Header.title, BranchChip);

// After each Send, once the message is stored and the folder exists on this computer:
// { threadId, messageId, text, folder, first }.
onCleanup(chat.onSent((sent) => beginTurn(sent)));
```

## Checks

- Window: `proto run bun -- run moon run chat:test` (builds `tests/fixtures/chat-probe`,
  a plugin that extends every element above, and loads it like the app does;
  checks Send announcements).
- End to end: `CARGO_BUILD_JOBS=2 cargo test --locked -p server --test chat_threads`
  (real server, real chat build, a real reply plugin, two clients, chat's real
  local part, and a shared server where a member is refused).
- Browser: `proto run bun -- run e2e:browser e2e/browser/chat.spec.ts`.
- Types: `src/client/tsconfig.json` and `tests/tsconfig.json` (in `workspace:plugins-check`).
