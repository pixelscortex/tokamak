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
