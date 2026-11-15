# Native component lab

Run `bun run ui:lab` from the repository root. This is a separate UI-only
workspace using the same Solid/QuickJS/Blitz/GPU path as the product.
It needs no server, SDK client, credentials or database.

One screen: the application shell with one rail section (Chat). The plugin
sidebar lists the lab's views; picking one swaps what the stage shows.

| View | What it shows |
| --- | --- |
| Chat | The chat view on the real `Composer` (docked: it rises out of the window base), `Select`, `Chip` and `Button`. Sending adds the message to the thread; `/todo` opens its command form. |
| Composer states | Each state of the one `Composer` as its own live composer, labelled: idle, with context, running, commands, command form, approval. |
| Select | The field size closed and open (with groups and search), the compact size, a menu that opens upward, a disabled select. |
| Buttons and keys | Every `Button` variant in each state (rest, hover, pressed, focused, disabled, live), the sizes, a toggle, `Kbd`, `Chip`. |

Files:

- `src/app.tsx`: the shell (top bar, rail, the views list) and view
  switching.
- `src/chat.tsx`, `src/composer-states.tsx`, `src/select.tsx`,
  `src/buttons.tsx`: one file per view.
- `src/mocks.ts`: all sample data (models, chips, commands, the run, the
  thread). Components take it through props; nothing in it is real.
- `src/fixtures.tsx`: markup only the tests need. It is not listed; tests
  open it with the `lab-test` host event (`src/app.tsx`). It uses the same
  shell and renderer.
- `src/kit.tsx`: sidebar rows and section titles; `src/icons.ts`: icon
  paths (Lucide ISC, Phosphor MIT).
- `src/styles.css`: imports, dark values for the older `.tk-button` /
  `.tk-input` theme and base element rules; everything else is Tailwind
  utilities in the views.
- `src/main.tsx`: mount entry. `src/main.rs`: launches with its own title
  bar (render `WindowOptions`). `app.config.json`: native title/window
  geometry.

Tests:

- `tests/native.rs`: behaviour through injected native events: the
  textarea grows line by line and stops at its limit; Enter submits and
  Shift+Enter adds a line; send enables with text; the select opens, moves
  with the keyboard, picks, searches, opens upward and closes on Escape and
  on a click outside; each composer state; the composer stays within 60%
  of the stage; buttons; layout at wide and narrow windows.
- `tests/shell.rs`: click and wheel interactions,
  stable control boxes, and
  every view settling without requesting frames. The ignored GPU tests
  render offscreen frames (pixel checks, and one capture of each view with
  `capture_views`, written to `$TK_CAPTURE_DIR`, default
  `/tmp/tkm-minimal-ui`):
  `cargo test --locked -p tokamak-lab --test shell -- --ignored --test-threads=1`.

Implement components in `packages/ui`, then show them here, with real
keyboard, focus and editing states and mock data from `src/mocks.ts`.

`moon run lab:check lab:test` validates the generated native assets. These
checks do not establish physical IME, VoiceOver, GPU presentation or latency.

Tailwind v4 runs only at build time, with maintained source extraction.
Shared sources are declared using `@source`; use complete static class
names rather than interpolated names. No-op assets retain their mtimes.
There is no watch/HMR or production plugin loader yet; this is the UI-only
application of the shared artifact pipeline.
