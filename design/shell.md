# Shell

The app frame every plugin appears in (`app/src/shell`): top strip with tabs,
the rail, the sidebar, the stage with its header and footer, and the panel.
It also owns a few pages of its own: welcome, add a server, members, devices,
plugins, and the sign-in and quit dialogs.
Paper page: `App 1:1 · Shell`.

## Screens

| Screen                                                             | Source                                                               | Paper artboard                |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------- |
| The frame with every region filled (sidebar, header, panel)        | `app/src/shell/frame.tsx`, `top-strip.tsx`, `rail.tsx`               | `Shell · frame`               |
| Welcome: "This Mac is ready", open Chat, join a friend's server    | `welcome.tsx`                                                        | `Shell · welcome`             |
| Add a server, step 1 of 4: the address                             | `connect/flow.tsx`, `connect/steps.tsx`, `connect/parts.tsx`         | `Shell · add a server`        |
| Sign-in dialog over the "needs you to sign in" band                | `sign-in.tsx`, `credential-fields.tsx`, `states.tsx` (`Unreachable`) | `Shell · sign-in`             |
| Members on a shared server                                         | `members.tsx`                                                        | `Shell · members`             |
| Devices on a shared server: people's devices, then plugin machines | `devices.tsx`                                                        | `Shell · devices`             |
| Plugins (desktop): the plugins folder and one loaded plugin        | `plugins.tsx`                                                        | `Shell · plugins`             |
| Plugins: one loaded, one failed with its reason                    | `plugins.tsx`                                                        | `Shell · plugins, one failed` |
| Plugins: an empty plugins folder                                   | `plugins.tsx`                                                        | `Shell · plugins, empty`      |
| `/kit`: Input and Switch in every state (dark column)              | `packages/ui/src/kit/inputs.tsx`                                     | `Kit · Input, Switch`         |

The kit artboard copies only the Input and Switch section of `/kit` (Controls
tab, dark column), the first primitives with a Paper copy; the rest of the kit is
not drawn. Focus rings are drawn as the same 2 px gap and 2 px ring in a shadow.

Not drawn yet: devices on This Mac ("Devices are managed on a shared server."), devices loading or reconnecting, members on This Mac ("Members are managed on a shared server."), the server menu, the settings menu, the search palette, connecting, can't reach a server (without the dialog), no
plugins, nothing here, the quit dialog, the add-member and rename dialogs,
connect steps 2 to 4, the frame without the rail or with the sidebar hidden,
the plugins page in the browser build (no "Reveal in Finder"), loading or with
a failed read.

### Devices

`devices.tsx` follows two live lists, each a server-sent-events stream read with
`readSnapshots` (`app/src/host/snapshots.ts`); every event is the whole list.

- **People's devices** (`/devices/live`): one row per signed-in device, a
  computer icon, the device name (with "This device" for this window), then a
  label line: the member, "Online" when connected, "Last seen <date, time>" or
  "Never connected". Each row has a ghost "Sign out" button. States:
  "Loading devices…", "No signed-in devices.", "Reconnecting to the device
  list…", and a red line when a sign-out fails.
- **Plugin machines** (`/devices/machines/live`, owner and admins only): a
  sandbox or VPS a plugin created. Below people's devices under a "Plugin
  machines" label (`text-label text-ink-3`, as the add-a-server "Recent"
  label), in the same row: a plug icon, the machine name, then the label line
  "<plugin name> plugin", "For <member>" when bound to a member, "Online",
  and the same "Last seen" text. No buttons: the owning plugin manages its
  machines. The group is not drawn at all while loading, when the list is
  empty, or when the server answers 403 (a member who may not manage
  devices); no error shows. A failed stream retries quietly every second.
- Can't reach the server: the page's `Unreachable` band covers both lists.

### Plugins

`plugins.tsx`, at `/settings/plugins`, opened from the Settings menu ("Plugins",
shown on every server, under Members and Devices) and from the "No plugins
installed" notice's "Open Settings → Plugins" button. It belongs to the shell,
so it works when every plugin has failed. Read-only: no install, remove or
switch-off; it never names an install script or a repository.

- It reads `GET /plugins` (`pluginsFolder`, each plugin's `folder`, `skipped`
  and `skippedFolders`, see `packages/server/PLUGINS.md`) and reads it again
  whenever the window's plugin catalog changes (the plugin-changed event after
  a reload).
- Layout: the Devices column (`max-w-read`, `px-6 py-8`), an intro line, then
  two groups under `text-label text-ink-3` labels: **Plugins folder** (the path
  in `text-data`, ink) and **Installed**.
- "Reveal in Finder" (ghost button) sits after the path only in the desktop app
  on This Mac; it calls `reveal_plugins_folder`, which opens the Runner's
  plugins folder (it takes no path). In the browser build, or for another
  server, the path is plain text.
- Rows: no hairline, `py-3`, a 16 px lead (plug icon in `ink-3`; the failed
  icon in `removed` for a skipped folder), the name (`text-row` medium; the id
  when the plugin has no name), then id and version in `text-data ink-3`
  (the id only when the name differs), the reason (`text-row ink-2`) for a
  failed one, and the folder (`text-data ink-3`). The trailing status is a
  quiet `text-label`: "Loaded" in `ink-3`, "Failed" in `removed`. Loaded
  plugins come first in catalog order, then skipped ones by key.
- Empty: the folder, then "Plugin builds placed in this folder are loaded."
- States: "Connecting…", "Loading plugins…", the `Unreachable` band, and a red
  line when the read or the reveal fails.

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

The desktop app's subscription sign-in commands (`app/src-tauri/src/sign_in_return.rs`,
TKM-295), which `ai-profiles` uses for both companies' returns:
`sign_in_return_listen` takes `port`, `path`, `expectedState`, `requestId` and
`timeoutMs` and waits for a GET with the exact path and one matching state on
IPv4 and, when supported, IPv6 loopback (ports 54545 for Claude and 1455 for
ChatGPT only, up to 15 minutes). `sign_in_return_cancel` takes `port` and
`requestId`, so cleanup cannot cancel a replacement listener.
Other connections to the port (a browser's preconnect that sends nothing, a
wrong path or state, a failed accept) never end the wait: each gets a 404 or is
dropped, and one the browser did not close first is closed with a reset, since
a close started by the listener leaves the port in TIME_WAIT (30 s on macOS)
and the next listen without `SO_REUSEADDR` would answer `busy`. `busy` means
only that another program, or such a leftover, holds the port; the caller tries
again later.
`sign_in_open_browser` takes an HTTPS `url` and opens it in the system
browser; the Windows opener is unverified. Every installed plugin's code in the
main window can use all three commands to open any HTTPS page, listen on
either allowed loopback port, and replace another listener there.

## What it adds to others

Nothing inside plugin parts. It frames them: the stage is `surface-stage`
with radius 12 on the window tone, 8 px from the window's right and bottom
edges (4 px when the panel is open).

## If you change X, check Y

- The subscription sign-in commands: ai-profiles' Profiles page and sign-in
  step use them, with each company's port and path from its `lib/companies.ts`;
  a new company's port goes into `allowed_port` too.
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
- `Unreachable` (a band, not a wall): Members, Devices and Plugins reuse it.
- The catalog fields the Plugins page reads (`pluginsFolder`, `folder`,
  `skipped`, `skippedFolders`): `readInstalled` in `plugins.tsx` and
  `app/tests/plugins-page.test.ts`.
- `NoPlugins` in `states.tsx`: its button opens the Plugins page;
  `e2e/browser/plugins-page.spec.ts` follows it.
- Device rows in `devices.tsx` (icon, name, label line, `LastSeen`): the plugin
  machines group uses the same row and the same `LastSeen`, so change both
  together.
- `/devices/machines/live` (its auth or its shape `{ id, name, owner: { plugin,
  name }, online, lastSeen, member? }`): the plugin machines group in
  `devices.tsx` and its tests in `app/tests/devices.test.tsx`.

## Primitives used

`Avatar`, `Button` (`quiet` on the unreachable band, `bare` for a tab's close
mark), `Dialog`, `Icon`, `icons`, `Kbd`, `Menu`, `Resizable`, `Row` (button
form: the tabs as `variant="tab"`, the welcome choices, recent servers),
`ScrollArea`, `StatusIcon`, `Tooltip`; its own `Control` (32 px ghost icon
button with a tooltip and keys) and `Notice`.

## Open questions

- The three `Shell · plugins` artboards are copies of the browser test run
  (`plugins page screens` in `e2e/browser/plugins-page.spec.ts`), so their
  paths are the run's temporary folders, not `~/Library/Application Support/…`.
- The rows break the System · rules row rule "no status words in rows": the
  ticket asks for "Loaded" and "Failed" as words. The icon carries the state
  too, so the word could go later.
- "Reveal in Finder" is the macOS wording; the command also opens the folder on
  Linux and Windows.

- `Shell · devices` was not taken from the screens run (that needs a Rust
  build); it is `Shell · members` copied and edited to match `devices.tsx`,
  with sample names. Replace it with a screens-run copy when one is next made.
  Its tab keeps the "New thread" title that `Shell · members` shows, with the
  computer icon.
- A plugin machine reads "<plugin name> plugin" on its label line. If plugin
  ownership gets a shared mark elsewhere (a chip, the plugin's own icon), use
  it here too.
- In the browser test run the sign-in dialog sits at the window's top-left
  corner, not in the middle (`Dialog.Content` centres itself with `m-auto`);
  `Shell · sign-in` copies it as the app draws it. Check whether the desktop
  app centres it.
- The Members page's tab reads "New thread" (with the person icon) instead of
  "Members"; `Shell · members` copies that too.
- With the external `ai-profiles` plugin installed the rail has a
  second mark, Profiles, under chat's. `Shell · frame` was copied before it
  existed and shows the rail without it; `App 1:1 · AI profiles plugin` shows
  it.
- The test app's rail also shows test-only views (F, P, T, W, O); the Paper
  copy leaves them out.
- The sign-in opener takes any HTTPS page: should it be limited to the
  companies' sign-in hosts?
- The top strip keeps 76 px (a 64 px spacer and 12 px) for the macOS window
  buttons only in the desktop app; the screenshots come from a browser, so the Paper copy has no gap there.
