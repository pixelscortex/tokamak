# Surfaces (`<tk-surface>`)

A surface is one fused, lit UI plate painted natively by the render host:
a short list of shapes combined into one signed distance field, filled flat,
with a bevel that lightens edges facing a single light and darkens edges facing
away. Shapes in one surface merge with curved joins (or cut into each other),
so plates read as one piece instead of boxes with borders or shadows.

It is a Blitz custom widget (`src/surface`), rendered on the GPU (wgpu,
`src/surface/surface.wgsl`) into a cached texture that Vello draws as an image.
One element is one group: only its own shapes interact, and it paints only its
own box. It has no children; put it as a positioned background layer behind
ordinary DOM content.

Most code should use the Solid components in `@tokamak/ui/components`
(`Surface`, `Surface.Union`, `Surface.Subtract`, `Shell`), where shapes are
ordinary elements placed by CSS layout (see "Layout binding"). The raw element
below is the low-level form, and the only way to write a `poly` by hand.

```tsx
<div style="position: relative; width: 520px; height: 300px">
  <tk-surface style="position: absolute; left: 0; top: 0; width: 520px; height: 300px"
    fill="#1b1b1b" bevel={2} join={10}
    shapes={JSON.stringify([
      { op: "add", x: 46, y: 0, w: 474, h: 300, r: 12 },
      { op: "add", x: 6, y: 116, w: 52, h: 44, r: [10, 0, 0, 10] },
    ])} />
  <p style="position: relative">Content above the surface</p>
</div>
```

## Attributes

All lengths are CSS px in the element's own box.

| Attribute | Default | Meaning |
| --- | --- | --- |
| `shapes` | `[]` | JSON list, combined in order (below). |
| `join` | `0` | Fillet radius where an `add` meets what is already there, and the rounding of corners a `sub` creates. Per shape `join` overrides. |
| `gap` | `0` | For `sub` shapes: cut the shape grown by `gap` and keep the shape itself as an island, leaving a ring. Per shape `gap` overrides. |
| `group` | none | Members naming this group in `surface-groups` add their boxes as shapes (layout binding). |
| `fill` | `#121212` | `#rgb`, `#rrggbb`, `#rrggbbaa`, or `var(--token)`: a theme custom property, resolved from the element's computed style (so materials use the same tokens as the CSS). |
| `bevel` | `2` | Width of the lit band inside the edge. |
| `light` | `0` | Light direction, degrees clockwise from straight up (0 = from the top). |
| `elevation` | `raised` | `raised` or `recessed` (recessed swaps lit and shadowed edges). |
| `border` | `0` | Border width along the whole silhouette (joins, cuts, rings; no seams). |
| `border-color` | `#2a2a2a` | Border colour (hex or `var(--token)`). |
| `border-align` | `inside` | `inside`, `center` or `outside` the silhouette. |
| `border-lit` | absent | How much the light modulates the border, 0 to 1: lighter where it faces the light, darker where it faces away. `true` (or present and empty) is 1, the full swing; `0.25` is a quiet hint; absent or `false` is flat. |
| `border-mix` | absent | Border colour derived from the fill: the fill moved this fraction of the way to white (`0.055` = 5.5% white over the fill). Overrides `border-color`, and follows a `var(--token)` fill. |

Shapes:

- `{"op":"add"|"sub","kind":"rect","x":..,"y":..,"w":..,"h":..,"r":..}`: `r` is
  one radius or `[tl, tr, br, bl]`.
- `{"op":..,"kind":"circle","x":..,"y":..,"w":..,"h":..}`: the circle in that box.
- `{"op":..,"kind":"poly","points":[[x, y, r], ...]}`: a simple polygon (either
  winding), every vertex rounded by its own `r` (convex or concave), `[x, y]`
  for a sharp vertex. Use this for notches with leaning sides: draw the panel
  and its notch as ONE outline, and every join is an exact arc of its radius.
- Every shape may also carry `join` and `gap`.

Changing `shapes` with the same count and ops animates per index (220 ms
ease-out); otherwise the new geometry shows at once. At most 4096 shapes.

Example notch: a panel top edge with a title notch whose right side sweeps
into the edge at 45 degrees, joins and corners of radius 14:

```json
[{"op":"add","kind":"poly","points":[
  [0,0,16],[190,0,14],[190,42,14],[340,42,14],[382,0,14],
  [520,0,16],[520,240,16],[0,240,16]]}]
```

## Layout binding

A surface's shapes can come from the layout boxes of ordinary elements
(`src/surface/bind.rs`), read after Blitz layout and before paint, without
going through an attribute or JS:

- The surface names a group: `<tk-surface group="name">`.
- A member element joins groups with `surface-groups="name other"` and
  optional settings: `surface-op` (`union` | `subtract`), `surface-radius`
  (`r` or `tl tr br bl`), `surface-join`, `surface-gap`, `surface-slant`
  (`a` or `left right` degrees from vertical; positive leans outward towards
  the top, so the top is the wide end that meets the plate edge; negative
  angles make the bottom the wide end), `surface-animate` and
  `surface-attach` (`left` | `right`, unions only: the member is attached
  by that side to a vertical edge of another union of the surface, as one
  exact outline with `join` as concave fillets at its top and bottom; level
  with the other shape's top or bottom its edge runs straight into it. The
  rail tab uses it).
- Its shape is its border box relative to the surface element's box. Unions
  come before subtractions, each in node order.
- A slanted member becomes an exact rounded outline whose two wide-end
  vertices carry the `join` radius: the fillets where its sides meet the plate
  edge are true circular arcs at any angle (a plain `join` between separate
  shapes is exact only at 90 degrees).

When it runs: once per window redraw, in the shell (`shell.rs`, on
`RedrawRequested`: `resolve`, then `NativeDocument::layout_surfaces`, then
Blitz paints). Nothing runs while the window is idle. A surface's shapes
change only if one of its members' boxes or settings changed, and then only
the dirty area is re-rendered.

Identity: every shape has a stable key (a member's node id; an entry of
`shapes` its index). Animation and partial re-rendering match old and new
shapes by key, never by list position, so members that appear or disappear
in the same pass (a view switch taking a title notch and a composer out of
the shell layers while the rail tab moves) neither stop nor redirect the
others. Dirty rects cover a moved shape's old and new area, an added
shape's new area and a removed shape's old area.

Animate or follow, per member: a member animates (220 ms) from its old box
to its new one only if it carries `surface-animate`, it was there before,
its box changed, AND the surface's own size did not change in the same pass.
A window resize moves members and resizes their surfaces together, so it
never animates; it just follows. Members that appear or disappear do so at
once. Each shape in flight runs on its own clock; a later pass that does not
change its target leaves it running. Shapes in flight are snapped to whole
device pixels, so a 1 px border on them does not crawl.

`@tokamak/ui`'s `Surface` components write these attributes; the shell's
layers have fixed group names, so a shape anywhere can join them
(`<Surface.Union layer="base">` cuts the layers above the window base so the
base shows through, fused with fillets).

Each surface also records its nesting depth and window position (`Bound` in
`bind.rs`) on every pass. Nothing uses them yet. They are the inputs for
lighting by depth, and for a window-level height map that would be rendered
once per frame from all surfaces' fields. Each surface's pass would sample
that map for contact shading. The hook point is the atlas pass in
`frame::end_frame`, which already runs once per frame before Vello.

## Plates (materials from classes)

For things that are each one plate (keycaps, trays, chips, cards) there is a
lighter way than one `Surface` per element: a plain element with a
`material-*` utility is a **plate**, and one **materials layer** per region
draws every plate of that region.

```tsx
<div class="material-tray flex gap-[3px] rounded-[10px] p-[3px]">
  <button class="material-key active:material-key-pressed rounded-[7px] px-3.5">Deny</button>
  <button class="material-key-bright active:bevel-1 rounded-[7px] px-3.5">Allow once</button>
</div>
```

- **Material.** The utilities (`packages/ui/src/materials.css`) set three
  registered, non-inherited custom properties: `--tk-fill` (a theme colour;
  without it nothing is drawn), `--tk-bevel` (CSS px) and `--tk-elevation`
  (`raised` | `recessed`). The layout pass reads them from the element's
  computed style, so states are plain CSS variants: `hover:`, `active:`,
  `aria-pressed:material-key-pressed`, `active:bevel-1`. No JS state, no
  attribute.
- **Shape.** The element's border box with its computed `border-radius`
  (`rounded-*`; elliptical corners are drawn circular).
- **Layer.** `<tk-surface materials>` draws the plates of the element that
  holds it (its parent): every plate whose nearest such element, starting
  at the plate itself, is that parent. Shapes in a layer do not fuse: each
  is shaded with its own material and painted over the ones before it, outer
  elements first (a tray, then the caps in it), then in document order. All
  of a region's plates paint below all of its content.
- **Regions own the layers.** Views never write one. `@tokamak/ui`'s shell
  puts one in every region: the top bar, the rail, the sidebar, the stage,
  and the two overlays on the stage (`TopBar at="stage"`, `BottomBar`),
  which float over the scrolled content and so need their own. The stage's
  layer is a sibling of the scroller, the size of the visible stage: plates
  are placed by their on-screen boxes after scrolling, a plate half out of
  view is cut at the stage edge (the texture ends there), and one out of
  view is skipped. Something floating outside the regions or above other
  content (a menu, a popover) is a `Sheet`: an element with its own layer,
  so it and its plates paint where the sheet sits in the stacking order.
  The sheet's own `material-*` class is its bottom plate.
- **Finding plates.** The render host tracks plates when attributes arrive
  (`wire.rs`), never by scanning the document. The build marks them: the
  `tokamak` Vite plugin (`packages/build/src/materials.ts`) adds `tk-plate`
  to every intrinsic JSX element whose `class` uses a `material-*` utility
  as a static string, and fails the build on a material name that
  `materials.css` does not define (naming the file, line, the bad name and
  the closest defined one). Static covers a string attribute and the string
  literals inside a `class={...}` expression: template literal text, both
  branches of `?:`, operands of `+`, `&&`, `||`, `??`, and `classList`
  keys; variants (`active:material-…`) included. Not covered, and found at
  run time instead by scanning the `class` of unmarked elements for a
  `material-*` token: classes built from variables or calls, a token cut by
  a substitution (`material-${name}`), spreads, and a component's `class`
  prop (checked by the build, not marked: the component decides where it
  lands). Marked elements skip that scan.
- **Cost.** A layer renders only the part of its box its plates reach,
  snapped out to a 64 device px grid, and nothing (no texture) without
  plates; plates outside the layer's box are skipped. A plate's material is
  re-read only when Stylo gives it a new computed style or its box changes
  size; otherwise the pass costs a pointer compare and a box read per plate.
  Static plates request no frames and re-render nothing; a pressed key
  re-renders its own area.

`Surface`, `Surface.Union` and `Surface.Subtract` remain the way to make
fused shapes, joins and cuts; plates are separate pieces.

Limits: within one region, plates paint below all of the region's content,
whatever its z-index (overlapping pieces that must stack go in a `Sheet`).
A plate whose box changes only through a CSS transform is not seen (boxes
are layout boxes, as for members).

## How it stays cheap

- **Caching.** Each surface keeps its rendered texture. A paint with nothing
  changed does no GPU work and its Scene only references the texture; a
  surface requests frames (`requires_redraw`) only while it animates, so an
  idle window repaints nothing.
- **Partial redraw.** When some shapes change, only the union of each changed
  shape's old and new bounds, padded by how far a shape can affect a pixel
  (join, gap, bevel, border, anti-aliasing), is re-rendered into the cached
  texture.
- **Tiling.** The target is cut into 32 px tiles and each tile lists only the
  shapes that can reach it, so a pixel evaluates its neighbours rather than
  the whole list. Culled output is identical to evaluating every shape
  (tested).
- **Atlas and one pass per frame.** Surfaces up to 512 px per side share one
  2048x2048 atlas texture per device; all of a frame's dirty surfaces render
  in one render pass and one submit, after Blitz has painted every widget and
  before Vello renders (`src/surface/frame.rs`, `FrameRenderer`). Larger
  surfaces keep their own texture. Measured before the atlas: the cost of
  many small surfaces was per render pass (per target texture), about 16 us
  of submit each plus Vello's per-texture copy.

## Measured cost

Lab stress test (`lab/tests/fused_surface.rs`, `stress_bench`), release build,
Apple M4 Pro, offscreen: the real lab document painted through blitz-paint and
Vello on a wgpu device, 1160x900 CSS px at scale 2, 20 warm-up then 100 frames
back to back. "Frame" includes a GPU-to-CPU readback of the whole 2320x1800
frame that a window does not do (about 1.4 to 1.9 ms with nothing running).
"Surfaces" is the CPU time spent in surface paints. A is N squares in one
surface (fused), B is N separate one-square surfaces; "moving" is how many of
the N move. Budget at 120 Hz: 8.3 ms.

| Config | Before (first GPU version) | After (current) frame / surfaces |
| --- | --- | --- |
| A 16 / 50 / 100 / 200, all moving | 1.8 / 2.4 / 3.9 / 7.8 ms | 1.6 to 2.0 ms / under 0.1 ms |
| A 1000 total, 10 or 100 moving | 32 ms | 2.0 to 3.2 ms / 0.1 to 0.9 ms |
| A 1000 static, something else repainting | 33 ms | 1.5 to 2.0 ms / 0.01 ms |
| B 16 / 50 / 100 / 200, all moving | 2.2 / 3.2 / 4.4 / 8.2 ms | 1.5 to 2.4 ms / under 0.1 ms |
| B 1000 total, 10 or 100 moving | 42 ms | 2.4 to 3.4 ms / 0.1 ms |
| B 1000 static, something else repainting | 47 ms | 2.6 to 3.1 ms / 0.1 ms |

Ranges cover repeated runs. Idle (nothing moving) is zero repaints: no surface
requests frames, verified by test and by the lab window idling at 0% CPU.
These are offscreen numbers; the lab's on-screen readout (`<tk-fps>`) shows
the live fps, frame time, surface time and re-rendered pixels.

Plates, 300 keycaps (`keycap_grid_bench`: the Stress view's variant C, 300
`material-key` buttons in a `material-tray`, against variant A stopped),
same setup, two runs each:

| | frame | scene build | surface paint | binding pass | re-rendered |
| --- | --- | --- | --- | --- | --- |
| without the grid, static | 2.31 / 2.43 ms | 0.12 / 0.13 ms | 0.003 / 0.005 ms | 9 / 17 us | 0 px |
| 300 plates, static | 4.02 / 3.96 ms | 1.07 / 1.06 ms | 0.008 / 0.009 ms | 60 / 69 us | 0 px |
| 300 plates, one cap toggled | 3.88 / 3.76 ms (worst 10.4 / 6.6) | 1.22 / 1.17 ms | 0.15 / 0.13 ms | | 7.1 kpx |

"Static" rows are forced repaints; left alone, the document requests no
frames (asserted). Most of the extra static frame time is Blitz painting
300 buttons and their text (scene build), not the layer. A toggle is a
click (pointer down and up, each with its restyle, layout and binding
pass: 5.0 ms for both together) plus the next frame.

## Known limits

- **Layout comes from members, not the widget.** A Blitz widget sees only its
  own size; member boxes reach it through the layout pass above. Raw `shapes`
  stay in px. A member that is not laid out (`display: none`) is skipped; a
  member whose box changes only through a CSS transform is not seen (boxes are
  layout boxes).
- **Hit testing.** Surfaces get `pointer-events: none` from the render host's
  user-agent stylesheet. Without it blitz-dom gives every event that hits a
  custom-widget node to the widget and skips the default action, so wheel
  scrolling stopped over a surface. Hit testing follows boxes, not shapes.
- **Joins between separate shapes** (`add`/`sub` with `join`) are exact arcs
  only where the edges meet at 90 degrees. For angled sides use one `poly`
  outline, whose joins and corners are exact at any angle.
- **Atlas capacity.** One 2048x2048 page per device holds about 726 surfaces of
  36 px at scale 2. Beyond that, surfaces fall back to their own texture
  (correct, slower: one more pass and one more Vello copy each).
- **Vello copies every registered texture every frame**: anyrender_vello 0.15
  `src/window_renderer.rs:463-465` marks each registered texture dirty on each
  frame and vello 0.11 `src/wgpu_engine.rs:486-504` copies it into Vello's
  image atlas. Not avoidable from here; the atlas reduces it to one copy
  (bounded to 16 MiB), and only on frames that are drawn at all.
- **Dependencies.** blitz-dom's `custom-widget` feature also enables its
  `accessibility` feature, which adds the `accesskit` crate to the build.
- **GPU only.** Surfaces need the wgpu (Vello) renderer and panic without a
  wgpu device, in line with the shell refusing software adapters. The CPU
  evaluator in `src/surface/reference.rs` exists only as a test oracle.
- **Embedding.** Code that paints a document without `launch_window` must call
  `NativeDocument::layout_surfaces` after `resolve` and
  `render::surface_end_frame()` after each `paint_scene`, or bound shapes are
  missing and surfaces stay blank (the window does both).
- **Scoped joins** (a join radius that applies only among some shapes, e.g. a
  future `Surface.Join`) are not built. The shape list is flat; it would
  become a two-level tree. Each member would carry a group id, and the field
  would evaluate each group with its own join before combining groups with
  the surface's join. The changes: `field` and the shader loop take one more
  level, per-group influence bounds for culling, and one more parameter slot
  per shape. Members already carry per-shape joins, so the binding needs no
  rewrite.

## Icons (`<tk-icon>`)

`src/icon.rs` draws SVG path data (`d`, square `view`, `fill` and/or
`stroke`, `stroke-width`) as vector fills and strokes in the Scene. Colours can
be `currentColor`, the element's computed CSS `color`, so text-colour
utilities colour icons. It replaces enabling Blitz's `svg` feature (usvg) for
icons. The whole of this round, including icons, the layout binding and the
shell, grew the release lab binary from 11,712,720 to 11,795,440 bytes.
