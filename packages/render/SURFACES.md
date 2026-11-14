# Fused surfaces

A group is an ordinary root with one background widget as its first child:

```html
<div tk-group="panel" style="position:relative;--tk-fill:#202020;border-radius:12px;--tk-bevel:2">
  <tk-surface group="panel" style="position:absolute;inset:0"></tk-surface>
  <!-- ordinary CSS content -->
</div>
```

The layer must absolutely fill the root, behind its content. User-agent CSS
keeps `pointer-events: none !important` on it: Blitz swallows events that hit
custom widgets. Ordinary elements keep their CSS backgrounds and events.

The root's computed style supplies the group's appearance:

- `--tk-fill`: registered `<color>`; unset or transparent draws nothing.
- `border-radius`: horizontal radius of each corner of the root's border box.
- `--tk-bevel`: inside edge width in CSS pixels; default 0.
- `--tk-bevel-inset`: 1 reverses the lighting; default 0.
- `--tk-bevel-strength`: lighting strength from 0 to 1; default 1.

Root attributes:

- `surface-own="false"` omits the root's own shape. Otherwise it is the first add.
- `surface-join="n"` supplies members' default join radius; default 0.

Any element anywhere in the document can join one or more groups:

```html
<div surface-groups="panel other" surface-op="cut"
     surface-join="8" surface-slant="0 45"></div>
```

Its border box, relative to each layer, is its shape. Its computed
`border-radius` supplies its four horizontal corner radii. Member attributes:

- `surface-op="add|cut"`: default add.
- `surface-join="n"`: overrides the root's default, CSS pixels.
- `surface-attach="left|right|top|bottom"`: add only; names the member's side
  touching a plain add's edge. Uses an exact rounded outline when a target exists.
- `surface-slant="a"` or `"left right"`: side angles from vertical, clamped
  to ±75 degrees. Positive widens the top; negative widens the bottom.
- `surface-animate`: tween a previously present member whose box changed,
  for 220 ms with cubic ease-out, unless the layer resized in the same pass.
  Arrivals and removals are immediate; unchanged targets keep their clocks.

Order is root, plain adds, attached adds, then cuts, each in document order.
The registry is fed by wire mutations, never by a document scan.
`NativeDocument::layout_surfaces()` reads boxes after layout, before painting.
Only running tweens request further frames. In-flight positions snap to device pixels.

Each paint rebuilds one outline with contours and holes. Rounded polygons,
attachments and slants retain the exact builders; paths flatten at 0.02 CSS px
for `geo` ordered union/difference. General joins use round-buffer closing
for adds and opening for cuts. This acts on the whole intermediate region,
so it can change unrelated narrow features. Buffer arcs have at most 0.01 CSS px sagitta.

The scene fills the outline, then strokes its flattened segments with twice
the bevel width, clipped to the outline. Outward normals facing straight up
lighten towards white (gain 0.18); downward normals darken towards black
(gain 0.45); horizontal normals keep the fill. Holes reverse their normals.
One opacity layer preserves the fill's alpha across overlapping edge strokes.
Segment colours approximate smooth lighting; overlapping round caps can show
small changes at joins. No raster or physical-display acceptance is implied
by the geometry and scene-command tests at device scales 1 and 2.

There are no surface textures, shaders, atlas, caches, renderer resources,
plates, sheets, guests, regions, per-shape materials, or end-of-frame hook.
Legacy surface styling and geometry attributes are ignored.
