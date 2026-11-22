# Code

Saves the Git worktree before and after each agent turn on the client that
runs it, and shows what changed. It has no screen of its own: it adds to
chat's header and messages and fills the shell's panel. Everything is read
from this client's Git through code's local part, so a plain browser shows none of it.
Paper page: `App 1:1 · Code plugin` (chat's open thread as the base, then
each screen with code's parts outlined and tagged).

## Screens

| Screen                                                                                 | Source                                                               | Paper artboard        |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------- |
| A reply with its change card; branch chip and layout control in the header             | `plugins/code/src/client/ui/change-card.tsx`, `ui/thread-header.tsx` | `Code · change card`  |
| The review panel open beside the thread: "Turn 2 · 3 files +6 −11", files, plain diffs | `ui/review-panel.tsx`                                                | `Code · review panel` |

Not drawn yet: "Started tracking · 12 files", a binary-only change, the
panel's notes ("Reading the changes…", "No turn in this thread has changed
files yet.", the 3,000-line cut), the skipped-files notice under a reply.

## Parts it offers

None. `code` publishes no `component`.

## What it adds to others

All actions are in `plugins/code/src/client/api.tsx`.

| Target                | Action                                          | What is drawn                                                                 | File                                                               |
| --------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| chat `Header.title`   | after                                           | Branch chip (mono, branch icon), read every 3 s while visible                 | `ui/thread-header.tsx` (`BranchChip`)                              |
| chat `Header.menu`    | before                                          | Layout control: "Thread only" / "Review panel" on a tray, pressed half lifted | `ui/thread-header.tsx` (`ReviewToggle`)                            |
| chat `Header.menu`    | after                                           | Mounts the review panel into the shell's `Region.Panel`                       | `ui/thread-header.tsx` (`ReviewPanelMount`), `ui/review-panel.tsx` |
| chat `Message.footer` | append, last reply of a turn that changed files | Change card: file icon, "4 files", +86 −21, "open in review ›"                | `ui/change-card.tsx`                                               |
| chat `Message.footer` | append, finished agent replies                  | Notices: skipped files over 50 MB, the hook warning                           | `api.tsx` (`SnapshotNotice`)                                       |
| chat `Composer.top`   | prepend                                         | Nothing drawn: prunes snapshot refs of deleted threads once per connection    | `api.tsx` (`SnapshotCleanup`)                                      |

Code depends on chat and optionally on ai; it reads ai's `turns:list` to find
and number a reply's turn ("Turn 2").

## If you change X, check Y

- The change card (`h-8`, `px-2`, `surface-card`, full column width): chat's
  `Message.footer` gap (8) and message column (760); ai's cards above it
  are narrower (`max-w-read`).
- The branch chip (`ms-2` after the title) or the layout control: chat's
  header (`gap-2`, the title truncates, the folder chip follows the title).
  Chat's own folder chip uses the same `Chip mono` look; keep them alike.
- The review panel's header (`h-12`, `ps-4 pe-2`): the shell's page header
  is also `h-12 ps-4 pe-2`, so the two lines sit level.
- Diff colours (`added`, `removed`, `diff-added`, `diff-removed`) and
  `text-code`: tokens in `packages/ui/src/theme.css`; light theme values too.
- The panel's default width (600) and minimum (320) belong to the shell
  (`app/src/shell/frame.tsx`); below 1280 px wide an open panel hides the sidebar.

## Primitives used

`Button`, `Chip`, `FileName`, `Icon`, `Row`, `ScrollArea`; `Region.Panel` from the SDK.

## Open questions

- Notices and the change card both append to `Message.footer` with no
  `order`; which one comes first is not set on purpose in the code.
- Without ai there are no turns to read, so the change card and panel stay
  empty; the README says ai is optional but does not say what code shows then.
