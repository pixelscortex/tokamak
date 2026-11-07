# Native UI elements

`@tokamak/ui/elements` exports Solid `Button` and `Input` for QuickJS + the
universal renderer. `@tokamak/ui/components` deliberately exports nothing.
No DOM globals, React dependency, overlays, animation, or accessibility-host claims.

```tsx
import { createSignal } from "solid-js";
import { Button, Input } from "@tokamak/ui/elements";

const [title, setTitle] = createSignal("");
<Input label="Todo" description="One task" value={title()} onValueChange={setTitle} />;
<Button defaultPressed={false} onPressedChange={(done) => save(done)}>Done</Button>;
```

## Contract

- `class` is a string, appended to the element's base class. Theme styles come
  from `@tokamak/ui/styles.css`; tokens live only in `@tokamak/ui/theme.css`.
- One composition convention: `render={(props, state) => <Custom {...props} />}`.
  Forward the **reactive** props, including handlers and ref, to one control;
  do not destructure/snapshot them. The callback and native/non-native choice
  describe the mounted control, not a mechanism for switching it during a gesture.
- Button is an action unless `pressed` or `defaultPressed` is supplied. `pressed`
  is controlled; `defaultPressed` initializes internal toggle state. `onClick`
  runs before the toggle; `preventDefault()` cancels it. Native buttons receive
  keyboard clicks from the renderer only. To swap to a `div`, set
  `nativeButton={false}`; UI then supplies role, tab stop, Enter and armed Space.
  Consumer key-handler cancellation, repeats, blur, disabled and composition are respected.
- Input's `value !== undefined` selects controlled mode. Otherwise it owns its
  value, initialized once by `defaultValue`. `onValueChange(value, nativeEvent)`
  reports edits; rejected controlled edits are restored, even if the prop did not
  change. `readonly` passes through to the verified native text editor.
- Input `label` and `description` create parts with IDs based on `id` (or a
  Solid-generated ID), joined with supplied `aria-labelledby`/`aria-describedby`.
  `class`, `id`, ref, events and ARIA belong to the control, not its field wrapper.
  Replacement controls must still be text inputs to retain native editing.
- Boolean `data-disabled`, `data-focused`, `data-pressed` (toggle only), and
  `data-invalid` (Input only) are **present when true, absent when false**.
  ARIA booleans are literal strings. Parts use `data-part`.
- Focus indication deliberately includes pointer focus where the native platform
  gives it. `:focus-visible` is unsupported in the verified Blitz version (TKM-14).
  Pointer clicking a button need not focus it; use Tab for keyboard checks.

## Build and native demo

```sh
moon run ui:check ui:build
CARGO_BUILD_JOBS=2 moon run render:build
./target/release/demo
```

Vite library mode + `vite-plugin-solid` compile TSX to the universal host, with
production client Solid, ES2022 and no HMR/DOM runtime. The official plugin uses
Babel internally; no custom Babel transform remains. Type checking is separate
and includes the TS build helpers. Build-only Node types never enter element types.
Tailwind's compiler resolves `@theme`/`@apply`; no custom scanner or CSS preflight.
The native executable embeds generated `render/dist/shell.html` and `demo.js`.
The static legacy shell remains available to existing renderer fixtures.

In the window, check action/toggle buttons, disabled controls, Tab focus,
Enter/Space once (including held Space), the swapped div button, uncontrolled
editing, controlled clear/readonly/disabled and invalid state after 24 characters.
Static pressed/disabled/invalid examples are also shown. A launch or offscreen
probe does **not** verify physical input; TKM-8's foreground manual gate remains.

## Research / dependencies (2026-11-06)

Learned, not copied: Base UI v1.9 `useRender`/Button/Field docs and source,
Solid Dynamic/props docs and universal spread source, Tailwind v4 theme docs,
and shadcn semantic-token guidance. Dynamic imports `solid-js/web`, so it is not
used; reactive `splitProps`/`mergeProps` plus callbacks fit this native host.
Firecrawl retrieved the main docs/useRender source, then required reauthorization;
remaining primary source/docs were read directly.

Registry metadata and maintained upstream APIs checked before adding build tools:
`vite` 8.3.6 (2,377,714 B unpacked), `vite-plugin-solid` 2.11.15 (146,272 B),
`tailwindcss` 4.3.4 (786,416 B), `@types/node` 26.6.6 (2,586,357 B, tooling only).
Plugin peers support Vite 8 and existing Solid 1.9.18. No new UI runtime library.
These npm unpacked sizes are **not** shipped bundle or native binary costs.
