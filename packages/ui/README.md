# Native UI elements

`@tokamak/ui/elements` exports Solid `Button`, `Input` and `Icon` for QuickJS +
the universal renderer. `@tokamak/ui/components` exports `Surface` and `Shell` (used by the lab only so far; the app's shell frame and plugin slots are
separate) and the controls `Button`, `Kbd`, `Chip`, `ChipMore`,
`Textarea`, `Select` and `Composer`. No DOM globals, React dependency, or
accessibility-host claims.

## Styling

One system: Tailwind v4 utilities written in the component, as complete static
class names, with tokens in `src/theme.css` (colours, radii, fonts). Ordinary
backgrounds and edges are CSS; fused groups read the same theme colours through
`surface-*` utilities.
Still on the older class pattern: the elements `Button` and `Input`
(`.tk-button`, `.tk-input`, `.tk-field` and their state rules in
`src/styles.css`); the todo plugin uses them. Do not add to that pattern: new
controls are in `@tokamak/ui/components`.

## Surfaces and shell

```tsx
import { Shell, Surface } from "@tokamak/ui/components";

<button class="bg-blue-600 rounded-md bevel px-3 py-2">Run</button>;
<div class="bg-card rounded-lg bevel p-4">
  <input class="bg-well rounded-md bevel-inset px-2" aria-label="Name" />
</div>;

<Surface class="surface-panel rounded-xl bevel p-4" join={10}>
  <Surface.Add attach="right" class="absolute -left-10 top-6 h-10 w-12 rounded-l-lg" />
  <Surface.Cut class="absolute right-4 top-4 size-10 rounded-full">
    <button class="size-10 rounded-full bg-chip bevel" aria-label="Run">Run</button>
  </Surface.Cut>
  Panel content
</Surface>;
```

`Surface` takes `class`, `style`, `id`, `ref`, `children`, `join` and `own`
(default true). Its first child paints one fused outline. `Surface.Add` and
`Surface.Cut` take the same element props plus `join`, `slant` (one angle or
[left, right]), `animate` (220 ms) and `layer` (base, sidebar, stage). Only
`Add` takes `attach` (left, right, top, bottom). Corners come from CSS.
`own={false}` uses only members. Member children stay above the shape.

`surface-*` sets the fused fill: theme colours, arbitrary colours, custom
properties and opacity (`surface-panel`, `surface-[#1b1b1b]`,
`surface-(--my-var)`, `surface-white/10`). Use `bg-*` on ordinary elements.
`bevel` adds a 1.5 px edge; `bevel-2` / `bevel-[0.75]` set its width,
`bevel-inset` reverses the light, and `bevel-quiet` uses strength 0.075 and a uniform edge lift of 0.055.
Ordinary edges use Tailwind's inset shadow slot and compose with rings and
outer shadows. An explicit Tailwind inset shadow replaces that slot.
Fused roots suppress CSS shadows because the renderer follows their outline.
`material-chip` and `material-well` are ordinary CSS shortcuts for the controls.

`Shell` provides the fixed top bar, rail, sidebar, scrolling stage and bottom
bar. Views teleport content with `Shell.TopBar` (`at`: start, center, end,
stage), `Shell.Rail`, `Shell.Sidebar`, `Shell.Stage` and `Shell.BottomBar`.
Members with `layer="base"` cut the layers above the window background;
`sidebar` and `stage` join those shell groups from anywhere under the shell.
`Icon` from `@tokamak/ui/elements` draws SVG path data, coloured by CSS.

## Controls (`@tokamak/ui/components`)

Ordinary CSS backgrounds with Tailwind utilities and theme tokens. Each
file starts with its usage and the details; the short version:

```tsx
<Button variant="primary" size="md" onClick={run}>Run</Button>   // primary | neutral | outline | destructive | ghost; sm | md | icon
<Button variant="ghost" size="icon" label="Attach" pressed={on()}>…</Button>
<Kbd keys={["cmd", "K"]} />
<Chip label="Buy milk" detail="Todo" onRemove={drop} />  <ChipMore count={3} />
<Textarea value={text()} onValueChange={setText} onSubmit={send} maxRows={8} placeholder="Reply…" />
<Select options={opts} value={v()} onValueChange={setV} size="compact" side="top" search mono />
<Shell.BottomBar>
  <Composer docked placeholder="Reply…" onSubmit={send} models={models} model={m()} onModelChange={setM}
    context={chips} running={run} onStop={stop} commands={commands} onCommand={pick}
    form={form} approval={approval} above={…} tools={…} />
</Shell.BottomBar>
```

- Buttons change fill on hover and press without moving. Focus uses
  `focus:ring-2` (`:focus`; Blitz has no `:focus-visible`).
- Fields use `bg-well bevel-inset`; open Select menus are fused groups.
- `Textarea` grows by layout, not measuring: an invisible copy of its text
  in the same grid cell sizes it (Blitz's `<textarea>` keeps a fixed
  `rows` height and reports no content height).
- `Select` closes on a click outside through the shell's root
  (`dismissOutside`); outside a `Shell` only by its keys and picks. Scripts
  cannot move focus in Blitz, so its search field is not focused on open;
  typing on the focused trigger goes into it.
- `Composer` owns the text; its states come from props (see composer.tsx).
  The shell's bottom bar is at most 60% of the stage, and the composer's
  text gives up lines first.

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
The native executable embeds generated `packages/render/dist/shell.html` and `demo.js`.
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
