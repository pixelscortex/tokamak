# Native UI elements

`@tokamak/ui/elements` exports Solid `Button`, `Input` and `Icon` for QuickJS +
the universal renderer. `@tokamak/ui/components` exports `Surface`, `Sheet` and
`Shell` (used by the lab only so far; the app's shell frame and plugin slots are
separate) and the plate controls `Button`, `Kbd`, `Chip`, `ChipMore`,
`Textarea`, `Select` and `Composer`. No DOM globals, React dependency, or
accessibility-host claims.

## Styling

One system: Tailwind v4 utilities written in the component, as complete static
class names, with tokens in `src/theme.css` (colours, radii, fonts). Surface
materials name the same tokens (`var(--color-panel)`), which the native widget
resolves from computed style, so the GPU surfaces and the CSS cannot drift.
Still on the older class pattern: the elements `Button` and `Input`
(`.tk-button`, `.tk-input`, `.tk-field` and their state rules in
`src/styles.css`); the todo plugin uses them. Do not add to that pattern: new
controls are in `@tokamak/ui/components`, where `Button` is the plate button.

## Surface, Sheet, Shell, plates, Icon

```tsx
import { Shell, Surface } from "@tokamak/ui/components";
import { Icon } from "@tokamak/ui/elements";

<Surface material="card" radius={10} class="flex flex-col gap-2 p-4">
  <Surface.Subtract class="absolute top-4 right-4 size-10" radius={20} gap={3}>
    <button aria-label="Capture" />
  </Surface.Subtract>
  Card content
</Surface>;

<Shell>
  <Shell.Sidebar>…</Shell.Sidebar>
  <Shell.Stage>…</Shell.Stage>
  <Shell.BottomBar>
    <Surface.Union layer="base" radius={[18, 18, 0, 0]} join={22} class="w-[640px]">…</Surface.Union>
  </Shell.BottomBar>
</Shell>;

<Icon d={paths.search} class="size-4 text-ink-3" />;
```

- `Surface` is one fused, lit layer (`material`: base, sidebar, panel, card,
  chip, well). Its box is the painted area and, by default, its first shape.
  `Surface.Union` / `Surface.Subtract` are ordinary elements laid out by CSS;
  the render host turns their boxes into shapes of the nearest Surface
  (`radius`, `join`, `gap`, `slant`, `animate`). Their children render above
  the surface. `Surface.Intersect` is reserved for masking.
- `Shell` is the fixed frame: top bar (the title bar with a custom title bar),
  rail, plugin sidebar, stage (the only scrolling part) and bottom bar. Views
  teleport content into regions with `Shell.TopBar` (`at`: start, center, end,
  stage), `Shell.Rail`, `Shell.Sidebar`, `Shell.Stage`, `Shell.BottomBar`, and
  join the shell's layers with `layer` (base, sidebar, stage).
- `Sheet` is a region of its own anywhere: a floating piece (a menu) or a
  part of a view that chooses who draws its plates (`plates="sheet"`).
- Plates: inside any region (shell regions, `Surface`, `Sheet`), an element
  with a solid `bg-*` or a `material-*` class is drawn by the render host,
  with no component: `bg-blue-600 elevation-3 hover:sink-1 active:pressed`
  for a button, `material-key` in a `material-tray` for keycaps. The
  utilities are listed in `src/materials.css`.
- `Icon` draws SVG path data natively; colour follows CSS `color`.

See `packages/render/SURFACES.md` for the renderer side.

## Controls (`@tokamak/ui/components`)

Plates (a solid `bg-*`) with Tailwind utilities and theme tokens only. Each
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

- Buttons stand off the surface (`elevation-3 hover:sink-1 active:pressed`,
  toggles `aria-pressed:pressed`); no bevel, border or shadow. Focus shows
  `focus:ring-2` (`:focus`; Blitz has no `:focus-visible`).
- Fields are recessed wells; menus are a `Sheet`.
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
