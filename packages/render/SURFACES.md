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

## Plates (backgrounds and materials from classes)

For things that are each one plate (buttons, keycaps, trays, chips, cards,
coloured boxes) there is a lighter way than one `Surface` per element: an
element with a solid background colour, inside a region, is a **plate**. Our
shader draws its fill and lit edge; Blitz paints no background for it.
Authors write ordinary Tailwind:

```tsx
<button class="bg-blue-600 bevel-2 rounded-md px-3 hover:bg-blue-500 active:bg-blue-700 active:recessed">Run</button>
<div class="material-tray flex gap-[3px] rounded-[10px] p-[3px]">
  <button class="material-key active:material-key-pressed rounded-[7px] px-3.5">Deny</button>
</div>
```

- **Fill.** Any solid `background-color`. The build gives each one a
  `--tk-fill` twin with the same value in the compiled stylesheet
  (`packages/build/src/fills.ts`); `--tk-fill` is a registered `<color>`
  (`packages/ui/src/materials.css`), so Stylo resolves theme variables,
  `oklch()`, hex and `color-mix()` into one computed colour, which the
  layout pass reads (alpha kept).
- **Edge.** `bevel-<n>` (CSS px; `bevel-2.5`, `bevel-[3]`) adds the lit
  edge band; without it the plate is flat. `raised` (default) or `recessed`.
- **Shape.** The element's border box, as Blitz paints it (the rounded
  layout), with its computed `border-radius` (`rounded-*`; elliptical
  corners are drawn circular).
- **States** are plain CSS variants on any of these: `hover:bg-…`,
  `active:bg-…`, `aria-pressed:bg-…`, `active:recessed`, `active:bevel-1`,
  `dark:bg-…` (Tailwind's default `dark:` is `prefers-color-scheme`). No JS
  state, no attribute.
- **`material-*`** utilities are shortcuts for a fill, a bevel and an
  elevation (`material-key` is `bg-chip bevel-2.5 raised`).

What is translated and what is not:

| Class | Plate? |
| --- | --- |
| `bg-<theme colour>`, `bg-[#hex]`, `bg-[rgb(...)]`, `bg-(--var)`, `bg-white/50`, `bg-chip/[0.3]`, with any variant | yes, that colour |
| `material-*` | yes, its fill, bevel and elevation |
| `bg-transparent`, `bg-current` (and `/50`), `bg-inherit` | no: not a colour of the element's own; Blitz paints it |
| gradients (`bg-linear-*`, `from-*`), images (`bg-[url(...)]`), `bg-none`, `bg-cover` and the other non-colour `bg-*` | no: Blitz paints them (an image over a translated colour sits above the plate) |
| a solid `background-color` from hand-written CSS or `@apply` | only on a marked element (see "Finding plates"); `.tk-button` is not one |
| any background outside a region (the window root, `body`) | no: nothing draws it there, Blitz paints it |

### Who draws a plate: itself, or the sheet

A **region** is an element marked `tk-region` that directly holds a
`<tk-surface materials>` layer ("the sheet"). `@tokamak/ui` makes them:
every shell region (the top bar, the rail, the sidebar, the stage, and the
two overlays on the stage), every `Surface`, and every `Sheet`. Views never
write a layer. A plate belongs to the nearest region, starting at the plate
itself. Inside a region, materials.css sets a plate's own
`background-color` to transparent (`[tk-region] [tk-plate]`).

The region chooses who draws its plates:

| | Self-painting (the default) | The sheet |
| --- | --- | --- |
| How to choose | nothing: `<Shell>`, `<Surface>`, `<Sheet>` (`tk-region`) | `plates="sheet"` on `Shell` (all shell regions), `Surface` or `Sheet` (`tk-region="sheet"`) |
| Who draws | the plate's own widget, on the element itself | the region's layer, one shader pass for all its plates |
| Paint order | the element's own place: after its border, before its text and children | below all of the region's content; among plates, outer elements first, then document order |
| Covers other content of its region (a bar over a scrolling list) | yes | no: the content shows over it |
| `z-index` between overlapping plates | yes | no (document order) |
| An ancestor's `opacity`, `transform`, `filter` | apply | do not apply; only the element's own `opacity` does |
| Clipped by | every scroll container and `overflow` clip around it | the region's box only |
| A plate while its content scrolls or the stage scrolls | not re-rendered (its shape is in its own box) | re-rendered where it moved |

To choose for a part of a view, wrap that part in a `Sheet`:
`<Sheet plates="sheet">…</Sheet>` is a region whose layer draws everything
inside it; a plain `<Sheet>` inside a sheet region paints its own plates
again. Choose the sheet where plates must be lit as one piece (light that
spreads from a plate onto its neighbours needs one shader pass that sees
them all); self-painting everywhere else. `Surface`, `Surface.Union` and
`Surface.Subtract` remain the way to make fused shapes, joins and cuts;
plates are separate pieces in either mode.

**Self-painting.** The layout pass (`bind.rs`) attaches a small widget
(`plate.rs`) to the plate's element once it is in the document. Blitz draws
a widget's scene as part of its element, inside whatever clips, opacity
layers and transforms apply to the element, which is where every row of the
table above comes from. The widget answers every input event with
`EventResult::Ignored`, so Blitz runs the element's own default action:
the element keeps focus, `:hover`, `:active`, click, keyboard activation
and wheel scrolling, and its text, layout and children are untouched. That
answer is the one change our Blitz fork carries (`BLITZ_CHANGES.md`,
change 1); without it a button with a widget is dead. A bevelled plate is
one slot in the shared atlas, rendered by the shader at the sub-pixel
position of its element and drawn on whole device pixels. A plate without a
bevel (and without guests, below) is a vector fill in the Scene: no
texture.

**Which elements cannot paint themselves, and who draws them.** An element
in Blitz has one slot for data of its own, and a widget takes it. So these
never carry a plate widget:

- `input`, `textarea`, `select`: the slot holds the text editor or the
  checked state.
- `img`, `svg`, `canvas`, `video`, `embed`, `iframe`, `object`, `table`
  (and any element with `display: table`), `link`, `style`, `title`.
- An inline element without a box of its own (a `<span>` in running text):
  Blitz does not paint it as an element, so it never draws a widget.
- An element that already carries a widget (`<tk-surface>`, `<tk-icon>`).

They are still plates. In a sheet region the sheet draws them like any
other. In a self-painting region the nearest self-painting plate they sit
in draws them, as its guests: `<div class="material-card"><input
class="material-well" /></div>` gives the field its recessed well on the
card, drawn by the card's widget over the card's own fill. Only when there
is no such plate between the element and its region does the region's
layer draw it (which is why every region keeps its layer, empty in the
common case). A guest is drawn under everything between it and the plate
that draws it, is cut at that plate's edge, and takes that plate's
opacity, transform and clip; its own `opacity` still applies.

**The sheet.** `<tk-surface materials>` draws the plates of the region that
holds it. Shapes in a layer do not fuse: each is shaded with its own
material and painted over the ones before it. The stage's layer is a
sibling of the scroller, the size of the visible stage: plates are placed
by their on-screen boxes after scrolling, a plate half out of view is cut
at the stage edge (the texture ends there), and one out of view is
skipped. A layer renders only the part of its box its plates reach, snapped
out to a 64 device px grid, and nothing (no texture) without plates.

### Finding plates

The render host tracks plates when attributes arrive (`wire.rs`), never by
scanning the document. The build marks them: the `tokamak` Vite plugin
(`packages/build/src/materials.ts`) asks the project's Tailwind design
system (its `src/styles.css`, else `@tokamak/ui/styles.css`) what each
static class token compiles to, and adds `tk-plate` to every intrinsic JSX
element with a token that compiles to a solid `background-color` or a
`--tk-fill`. It fails the build, naming the file, line, token and the
closest known name, on a `bg-*`, `bevel-*` or `material-*` token (or
`raised` / `recessed`) that Tailwind generates nothing for (`bg-blu-600`,
an unknown variant), and on a malformed `bg-[#hex]`. Static covers a string
attribute and the string literals inside a `class={...}` expression:
template literal text, both branches of `?:`, operands of `+`, `&&`, `||`,
`??`, and `classList` keys. Not covered, and found at run time instead by
scanning the `class` of unmarked elements for a `material-*` or `bg-*`
token (other than `bg-transparent`, `bg-current*`, `bg-inherit`): classes
built from variables or calls, a token cut by a substitution
(`bg-${tone}`), spreads, and a component's `class` prop (checked by the
build, not marked: the component decides where it lands). The host then
sets `tk-plate` on the element natively, so the stylesheet treats it like a
marked one. Marked elements skip that scan. Whatever found it, the computed
`--tk-fill` decides whether anything is drawn.

### What each frame costs

The layout pass runs on every redraw. Per plate it decides who draws it (a
walk up its ancestors to the nearest region), reads its painted box, and
re-reads its material only when Stylo gave it a new computed style, its
box changed size or its painter changed (otherwise a pointer compare).
Static plates request no frames and re-render nothing in either mode; a
pressed key re-renders its own plate (self-painting) or its own area of
the layer (the sheet).

What Blitz does on every frame for each element that carries a widget
(blitz-paint 0.3.0-beta.4 `lib.rs`, `render.rs`), so for each self-painting
plate, changed or not, on screen or not:

1. Before walking the tree, it copies the list of widget nodes and, for
   each one that has a size, reads the node's size, clones the reference to
   its computed style and calls the widget's `paint`. Ours returns a Scene with one image fill
   (bevelled) or one vector fill (flat), and does no GPU work when nothing
   changed. Blitz keeps the Scene in a map by node.
2. While walking the tree it looks up that map for every element it paints
   (with or without a widget).
3. When it reaches the plate's element, and only if the element is not
   culled, it clones the Scene and appends it at the element's content box,
   inside the element's clip, opacity and transform.

Blitz does not skip `paint` for widgets that are scrolled out of view (its
own to-do), so a plate out of view still costs step 1. To keep that from
also costing a texture each (a long list scrolled away), the layout pass
hands no shape to a plate whose box lies outside the window: it draws
nothing and gives its atlas slot back, and renders again when it scrolls
in. A plate under a CSS transform is always kept, because its layout box
does not say where it shows. A static document still requests no frames:
none of this runs while the window is idle.

### Limits

Self-painting:

- The plate is clipped like the element's content: on an element that
  clips its overflow (`overflow: hidden`, `auto`), to the padding box. With
  a CSS border on such an element, the plate does not reach under the
  border.
- The plate follows a CSS transform as an image: scaled up, its edges are
  as soft as a scaled image's.
- A plate on an element that cannot carry a widget (the list above) is
  drawn by the plate around it or by the region's layer: under the content
  between the two, and cut at the edge of the plate that draws it.
- Every bevelled plate in the window is its own piece of GPU state: up to
  512 device px a side it is a slot in the shared atlas (about 790 caps of
  44 x 26 CSS px at scale 2 fit; beyond that they fall back to own
  textures); a larger one has its own texture, which Vello copies on every
  drawn frame (see "Known limits"). Many large bevelled plates are cheaper
  on a sheet. Flat plates cost no texture at any size.

The sheet:

- Plates paint below all of the region's content, whatever its z-index. A
  background that must cover other content of its region (a bar over
  scrolled text, a positioned panel over siblings) does not. Overlapping
  sibling plates paint by depth, then document order, not by z-index.
- An ancestor's `opacity`, any `transform` (boxes are layout boxes) and
  `filter` do not apply to a plate; the element's own `opacity` does.
- A plate inside a nested scroll container (other than the stage) is not
  clipped by that container.

Both:

- `background-clip`, `background-origin` and borders: the plate is the
  whole border box; Blitz still paints the border, above the plate.
- A dynamic class mixing `bg-current` (or `bg-inherit`) with another `bg-*`
  token that makes it a plate loses the `currentcolor` background inside a
  region (the plate cannot draw it). Static classes are not affected (the
  build only marks translated tokens).

Each row of the table is a pixel test on the lab's "Plate painters" rows
(`lab/tests/fused_surface.rs`, `the_two_painters_differ_where_documented`);
`both_painters_draw_the_same_keycaps` checks that, where the sheet has no
limit, the two draw the same pixels (to 1/255 on bevelled plates, 7/255 on
the anti-aliased corners of flat ones, which Vello fills).

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

Plates, both painters (`keycap_grid_bench` and `lab_views_bench`), same
setup: release build, Apple M4 Pro, offscreen, 1440x900 CSS px at scale 2,
100 forced repaints per row. Ranges cover three runs of two passes each
(2026-11-11, commit 33dc800). "Frame" includes the GPU-to-CPU readback of
the whole frame (about 1.4 to 1.9 ms) that a window does not do, and is the
noisiest number: its spread between runs (about 1.5 ms) is larger than any
difference between the painters.

300 keycaps (the Stress view's variant C: 300 `material-key` buttons in a
`material-tray`, against variant A stopped; 303 plates with the two the
view always has and the lab's switch):

| | frame | scene build | surface paint | binding pass | re-rendered |
| --- | --- | --- | --- | --- | --- |
| without the grid, self-painting | 2.6 to 3.6 ms | 0.14 to 0.17 ms | 0.005 to 0.011 ms | 13 to 42 us | 0 px |
| without the grid, sheet | 2.3 to 3.7 ms | 0.13 to 0.23 ms | 0.005 to 0.014 ms | 19 to 79 us | 0 px |
| 300 plates static, self-painting | 4.3 to 6.1 ms | 1.22 to 1.35 ms | 0.044 to 0.067 ms | 72 to 145 us | 0 px |
| 300 plates static, sheet | 3.9 to 5.7 ms | 1.07 to 1.29 ms | 0.011 to 0.016 ms | 95 to 197 us | 0 px |
| one cap toggled, self-painting | 4.0 to 6.4 ms (worst 7.1 to 9.3) | 1.22 to 1.40 ms | 0.047 to 0.067 ms | | 4.6 kpx |
| one cap toggled, sheet | 4.0 to 5.7 ms (worst 7.4 to 9.0) | 1.24 to 1.35 ms | 0.138 to 0.202 ms | | 7.1 kpx |

- "Static" rows are forced repaints; left alone, the document requests no
  frames and re-renders 0 px in both modes (asserted by both benches and by
  `settled_sections_request_no_frames_and_render_nothing`).
- Most of the static frame time of the grid is Blitz painting 300 buttons
  and their text (scene build), in either mode.
- Self-painting adds, per frame and per plate, about 0.15 us in the
  widget's `paint` (surface paint: 0.05 ms for 300 against 0.013 ms for the
  one layer) and about 0.4 us in all (scene build: Blitz's call, the Scene
  it keeps and the clone it appends).
- A toggle re-renders one cap (4.6 kpx) self-painting, and that cap's area
  of the layer padded to the dirty grid (7.1 kpx) on the sheet.
- A toggle is a click (pointer down and up, each with its restyle, layout
  and binding pass: 5.3 to 6.0 ms for both together, the same in both
  modes) plus the next frame. The worst single frame after a toggle is over
  the 8.3 ms budget in some runs in both modes, readback included.
- The binding pass in this table runs between frames, with cold caches.
  In a tight loop (`keycap_grid_binding_pass_cost`, scale 1, 200 passes,
  three runs) it is 54 to 55 us self-painting and 58 to 59 us with the
  sheet, for the same 301 plates (57 to 63 us before plates could paint
  themselves).

Every lab view as it opens (static, forced repaints; all settled, requested
no frames and re-rendered 0 px). "Sheet plates" are drawn by a layer,
"own" paint themselves:

| View | painter | layers | sheet plates | own | static frame | scene build | surface paint | binding pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chat | self | 13 | 0 | 8 | 2.9 to 4.2 ms | 0.18 to 0.24 ms | 0.008 to 0.015 ms | 20 to 73 us |
| Chat | sheet | 13 | 7 | 1 | 2.8 to 4.7 ms | 0.16 to 0.23 ms | 0.006 to 0.011 ms | 26 to 79 us |
| Components | self | 12 | 0 | 1 | 2.6 to 4.2 ms | 0.14 to 0.19 ms | 0.004 to 0.009 ms | 13 to 67 us |
| Components | sheet | 12 | 1 | 0 | 2.5 to 4.7 ms | 0.14 to 0.17 ms | 0.004 to 0.008 ms | 24 to 75 us |
| Surfaces | self | 20 | 11 | 27 | 2.5 to 4.2 ms | 0.22 to 0.24 ms | 0.013 to 0.020 ms | 43 to 92 us |
| Surfaces | sheet | 20 | 37 | 3 | 2.4 to 4.7 ms | 0.20 to 0.24 ms | 0.008 to 0.015 ms | 39 to 104 us |
| Stress (A, stopped) | self | 10 | 0 | 3 | 2.4 to 3.6 ms | 0.14 to 0.16 ms | 0.005 to 0.010 ms | 17 to 69 us |
| Stress (A, stopped) | sheet | 10 | 3 | 0 | 2.9 to 4.2 ms | 0.14 to 0.17 ms | 0.006 to 0.009 ms | 24 to 86 us |

The lab's switch changes the shell regions only: the Surfaces view's 11
sheet plates in "self" are its `plates="sheet"` comparison cells, and the
"own" plates that remain in "sheet" are inside a `Surface` or a plain
`Sheet` (regions of their own). The Surfaces view has more self-painting
plates than the 27 counted: those below the fold hold no shape until they
scroll in. The 8 more layers than before are the comparison cells.

Before plates could paint themselves (commit 0c6d914, the sheet only, two
runs each): the grid static 3.69 to 4.40 ms with 57 to 63 us of binding
pass, one cap toggled 3.76 to 3.88 ms; Chat 2.86 to 2.91 ms, Components
2.53 to 3.18 ms, Surfaces 2.76 to 3.65 ms, Stress 2.78 to 2.83 ms.

## Known limits

- **Layout comes from members, not the widget.** A Blitz widget sees only its
  own size; member boxes reach it through the layout pass above. Raw `shapes`
  stay in px. A member that is not laid out (`display: none`) is skipped; a
  member whose box changes only through a CSS transform is not seen (boxes are
  layout boxes).
- **Hit testing.** Surfaces get `pointer-events: none` from the render host's
  user-agent stylesheet. Without it blitz-dom gives every event that hits a
  custom-widget node to the widget and, unless the widget answers
  `EventResult::Ignored` (our fork's change; `<tk-surface>` does not), skips
  the default action, so wheel scrolling stopped over a surface. Hit testing
  follows boxes, not shapes. A self-painting plate needs none of this: its
  widget ignores every event and its element is hit like any other.
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
  `blitz-dom` comes from our fork of Blitz (one commit over 0.3.0-beta.4,
  see `BLITZ_FORK.md`): self-painting plates need its `EventResult`.
- **GPU only.** Surfaces need the wgpu (Vello) renderer and panic without a
  wgpu device, in line with the shell refusing software adapters. The CPU
  evaluator in `src/surface/reference.rs` exists only as a test oracle.
- **Embedding.** Code that paints a document without `launch_window` must call
  `NativeDocument::layout_surfaces` after `resolve` and
  `render::surface_end_frame()` after each `paint_scene`, or bound shapes are
  missing, plates have no widget and surfaces stay blank (the window does
  both).
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
