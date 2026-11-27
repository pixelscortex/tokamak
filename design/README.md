# Design

Tokamak draws the shell. Its design note is [shell.md](shell.md) and its Paper
page is `App 1:1 · Shell`.

Each plugin's design note lives in its own folder in
[tokamak-plugins](https://github.com/pixelscortex/tokamak-plugins) as
`plugins/<id>/DESIGN.md`. Those notes record the screens and parts each plugin
draws and what it adds to other screens.

## The sync rule

Every change to what a screen looks like does three things in the same piece of work:

1. Update the design note: `shell.md` here for the shell, or the plugin's
   `DESIGN.md` in its own folder.
2. Update that screen's `App 1:1` page in Paper so it looks the same as the app.
3. Read the “If you change X, check Y” notes of every affected plugin and check
   those screens too.

Review checks all three. The owner's Paper pages (Chat, Plugins · coding,
notes, System · rules, the moodboard and the rest) belong to the owner: never
edit those nodes. Whoever changes the UI keeps the `App 1:1` pages in sync.

## Capture the shell for Paper

The `App 1:1` artboards are plain copies of the app at 1728 × 1117 in the dark
theme, with no extra outlines or labels.

1. `TOKAMAK_SCREENS=<folder> TOKAMAK_E2E_PORT=1550 CARGO_BUILD_JOBS=2 proto run bun -- e2e/browser.ts screens.spec.ts --project chromium`
   captures the shell with fixture plugins and writes each screenshot as a PNG
   alongside its laid-out tree and computed styles as JSON.
2. `proto run bun -- e2e/paper-html.ts <folder>/<name>.json` turns a tree into
   HTML for Paper's `write_html` using the browser's box sizes, colors, and
   fonts. Use `--page` with a layer path to write one region such as `Panel`.
3. Paste the HTML into an artboard of the same name and compare its screenshot
   with the PNG.
