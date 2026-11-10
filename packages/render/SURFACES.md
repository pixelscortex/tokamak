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
| `fill` | `#121212` | `#rgb`, `#rrggbb` or `#rrggbbaa`. |
| `bevel` | `2` | Width of the lit band inside the edge. |
| `light` | `0` | Light direction, degrees clockwise from straight up (0 = from the top). |
| `elevation` | `raised` | `raised` or `recessed` (recessed swaps lit and shadowed edges). |
| `border` | `0` | Border width along the whole silhouette (joins, cuts, rings; no seams). |
| `border-color` | `#2a2a2a` | Border colour. |
| `border-align` | `inside` | `inside`, `center` or `outside` the silhouette. |
| `border-lit` | absent | Present (and not `false`): the border is lighter where it faces the light and darker where it faces away, instead of flat. |

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

- **No layout access.** A widget sees only its own size, not its siblings'
  or children's boxes, so shape geometry is given in px by the page.
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
  `render::surface_end_frame()` after each `paint_scene`, or surfaces stay
  blank (the window does this in `FrameRenderer`).
