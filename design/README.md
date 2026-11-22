# Design

This folder records how the plugins' screens relate: which plugin draws
what, which parts it offers, and what it adds to another plugin's screen.
Paper shows how screens look; it cannot show that a change in chat's composer
moves ai's agent row. These files do.

Each plugin with UI has one file, with the same five sections:

1. **Screens**: what it draws, the source file, the Paper artboard.
2. **Parts it offers**: named parts others may add to or replace.
3. **What it adds to others**: its additions to other plugins' screens.
4. **If you change X, check Y**: what else moves when this changes.
5. **Primitives used** from `@tokamak/ui`.

Then **Open questions** for anything the code does not settle.

| File                   | Plugin                          | Paper page              |
| ---------------------- | ------------------------------- | ----------------------- |
| [shell.md](shell.md)   | The app frame (`app/src/shell`) | `App 1:1 · Shell`       |
| [chat.md](chat.md)     | `chat`                          | `App 1:1 · Chat plugin` |
| [ai.md](ai.md)         | `ai`                            | `App 1:1 · AI plugin`   |
| [code.md](code.md)     | `code`                          | `App 1:1 · Code plugin` |
| [claude.md](claude.md) | `claude` (data only, no UI)     | none                    |
| [codex.md](codex.md)   | `codex` (data only, no UI)      | none                    |

`basic-auth` draws nothing; its sign-in fields are drawn by the shell's sign-in dialog.

## The sync rule

Every change to what a screen looks like does three things in the same piece of work:

1. Update the plugin's `design/<plugin>.md`.
2. Update that plugin's `App 1:1` page in Paper so it looks the same as the app.
3. Read the "If you change X, check Y" notes of every plugin listed as
   affected, and check those screens too.

Review checks all three. The owner's own Paper pages (Chat, Plugins · coding,
notes, System · rules, the moodboard and the rest) belong to the owner: never edit those
nodes. The `App 1:1` pages are kept by whoever changes the UI.

## Who adds to whom

Rows: the plugin that adds. Columns: whose screen it changes.

| Plugin        | shell                                                        | chat                                                                                                                                                                       | ai                                                                                     |
| ------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| chat          | Sidebar: thread list. Header: thread header. Rail: chat mark | —                                                                                                                                                                          | —                                                                                      |
| ai            | —                                                            | Composer: agent row, permission card, Stop. Empty: heading. Message: reply header, work lines, tasks/plan/usage, steers. Thread row: status icon, detail line, helper rows | —                                                                                      |
| code          | Panel: review panel                                          | Header: branch chip, layout control. Message footer: change card, notices                                                                                                  | Reads turns (`turns:list`); draws nothing in ai                                        |
| claude, codex | —                                                            | —                                                                                                                                                                          | Name, mark, models, levels, speeds, modes, reports (data through the `agent` contract) |

## How the Paper pages are made

The `App 1:1` artboards are copies of the running app at 1728 × 1117 in the
dark theme, built from the app itself rather than redrawn by hand:

1. `TOKAMAK_SCREENS=<folder> TOKAMAK_E2E_PORT=1550 CARGO_BUILD_JOBS=2 proto run bun -- e2e/browser.ts screens.spec.ts --project chromium`
   takes each screen (`e2e/browser/screens.spec.ts`) and writes `<name>.png`
   and `<name>.json`, the laid-out tree with computed styles (`e2e/browser/screen-tree.ts`).
2. `proto run bun -- e2e/paper-html.ts <folder>/<name>.json` turns a tree
   into HTML for Paper's `write_html`: every box placed at the size the
   browser gave it, colours as hex, Geist and Geist Mono, one text box per
   text. `--page` with a layer path writes one region (such as `Panel`).
   `PAPER_DROP` leaves out layers by name prefix; no page uses it today.
3. Paste it into an artboard of the same name, then compare the artboard's
   screenshot with the PNG.

Every artboard is a plain copy of one screen: nothing is drawn on top of it,
no outlines and no labels. Which plugin adds which part, and on which
artboard it shows, is written in each plugin's "What it adds to others"
table here, not in Paper.

The AI and Code pages start with `Base · Chat · open thread`, chat's open
thread as the chat page draws it. The other artboards on those pages are the
whole app with every plugin on, so an AI artboard also shows code's branch
chip, layout control and change card, as the app does.

The copies leave out what only the test app draws: the fixture plugins' rail
letters (F, P, T, W, O) and the fake agent's "Replayed by the fake agent"
line. Names and models come from the test agent ("Fake agent", "work").

**Matched to:** `dev` at `b305b4c8` ("Cover static class expressions and
simplify lint configuration", 2026-11-22), merged into `design/app-map` at
`af0474e3`. The screenshots were taken from that merge plus this branch's
test changes (no app code changed).

## Open questions

- `claude.md` sits on a case-insensitive disk on macOS, where it is the same
  file as `CLAUDE.md`, which Claude Code loads as instructions for this
  folder. Renaming it (for example `claude-agent.md`) would avoid that.
