# Shell

The app frame every plugin appears in (`app/src/shell`): top strip with tabs,
the rail, the sidebar, the stage with its header and footer, and the panel.
It also owns a few pages of its own: welcome, add a server, members, devices,
and the sign-in and quit dialogs.
Paper page: `App 1:1 · Shell`.

## Screens

| Screen                                                          | Source                                                               | Paper artboard         |
| --------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------- |
| The frame with every region filled (sidebar, header, panel)     | `app/src/shell/frame.tsx`, `top-strip.tsx`, `rail.tsx`               | `Shell · frame`        |
| Welcome: "This Mac is ready", open Chat, join a friend's server | `welcome.tsx`                                                        | `Shell · welcome`      |
| Add a server, step 1 of 4: the address                          | `connect/flow.tsx`, `connect/steps.tsx`, `connect/parts.tsx`         | `Shell · add a server` |
| Sign-in dialog over the "needs you to sign in" band             | `sign-in.tsx`, `credential-fields.tsx`, `states.tsx` (`Unreachable`) | `Shell · sign-in`      |
| Members on a shared server                                      | `members.tsx`                                                        | `Shell · members`      |
| `/kit`: Input and Switch in every state (dark column)           | `packages/ui/src/kit/inputs.tsx`                                     | `Kit · Input, Switch`  |

The kit artboard copies only the Input and Switch section of `/kit` (Controls
tab, dark column), the first primitives with a Paper copy; the rest of the kit is
not drawn. Focus rings are drawn as the same 2 px gap and 2 px ring in a shadow.

Not drawn yet: devices on a shared server (`devices.tsx`), members on This Mac ("Members are managed on a shared server."), the server menu, the settings menu, the search palette, connecting, can't reach a server (without the dialog), no
plugins, nothing here, the quit dialog, the add-member and rename dialogs,
connect steps 2 to 4, the frame without the rail or with the sidebar hidden.

## Parts it offers

Plugins place content with regions from `@tokamak/sdk/client`, inside a `view`:

| Region           | Where it shows                                                                                                | Filled by today                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `Region.Sidebar` | The column left of the stage (default 244 px, 200–420, resizable), under the server switcher, `density-dense` | chat's thread list                     |
| `Region.Header`  | The stage's 48 px header (`ps-4 pe-2`, gap 8); when empty the page title shows                                | chat's thread header, the connect page |
| `Region.Panel`   | A second stage right of the main one (default 600 px, min 320, resizable)                                     | code's review panel                    |

Also from the shell: the rail mark of each `view` (its `icon`, or its first
letter; `ai-profiles` adds the Profiles page with a person mark under chat's), tab titles (`usePageTitle`), shortcuts (`useShortcuts`), quit
blockers (`quitBlockers`).

## What it adds to others

Nothing inside plugin parts. It frames them: the stage is `surface-stage`
with radius 12 on the window tone, 8 px from the window's right and bottom
edges (4 px when the panel is open).

## If you change X, check Y

- Sidebar padding (`pt-1 pe-3 pb-3 ps-2`) or its density: chat's thread rows
  (`px-row`, 32 tall in dense) and ai's detail and helper rows.
- Stage header height or padding (`h-12 ps-4 pe-2`): chat's thread header
  (title, chips, menu) and code's review panel header, which matches it.
- Stage width or padding: chat's message column (`max-w-thread` 760, `px-8`)
  and composer; ai's work lines; code's change card.
- Panel default width (600) or the 1280 px rule (a panel hides the sidebar
  below it): code's review panel.
- `--tk-nav` / `w-nav`: the tabs start at the stage's left edge; resizing the
  sidebar moves them.
- Footer (`h-8`, connection, unsaved line): every page's bottom spacing,
  including chat's composer (`pb-4`).
- `Unreachable` (a band, not a wall): Members and Devices reuse it.

## Primitives used

`Avatar`, `Button` (`quiet` on the unreachable band, `bare` for a tab's close
mark), `Dialog`, `Icon`, `icons`, `Kbd`, `Menu`, `Resizable`, `Row` (button
form: the tabs as `variant="tab"`, the welcome choices, recent servers),
`ScrollArea`, `StatusIcon`, `Tooltip`; its own `Control` (32 px ghost icon
button with a tooltip and keys) and `Notice`.

## Open questions

- In the browser test run the sign-in dialog sits at the window's top-left
  corner, not in the middle (`Dialog.Content` centres itself with `m-auto`);
  `Shell · sign-in` copies it as the app draws it. Check whether the desktop
  app centres it.
- The Members page's tab reads "New thread" (with the person icon) instead of
  "Members"; `Shell · members` copies that too.

- With `ai-profiles` installed (it is in the starter set) the rail has a
  second mark, Profiles, under chat's. `Shell · frame` was copied before it
  existed and shows the rail without it; `App 1:1 · AI profiles plugin` shows
  it.
- The test app's rail also shows test-only views (F, P, T, W, O); the Paper
  copy leaves them out.
- The top strip keeps 76 px (a 64 px spacer and 12 px) for the macOS window
  buttons only in the desktop app; the screenshots come from a browser, so the Paper copy has no gap there.
