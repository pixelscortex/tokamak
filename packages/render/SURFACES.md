# Fused vector groups

A group is one ordinary root; there is no surface element or widget:

```html
<div tk-group="panel" style="--tk-fill:#303030;border-radius:12px;--tk-bevel:1.5">
  <div surface-groups="panel" surface-attach="right"></div>
</div>
```

Tokamak's element painter draws the combined fill and edge at the root's
`Background` piece, only when it paints its own box, then paints Blitz's
background and all remaining pieces normally. CSS background images still
work. The shape is above the root's backdrop and below its border, content
and children, inside ancestor clips and Blitz's clip-path, mask, opacity,
filter and transform layers. The root's own overflow does not clip the fused
shape: it behaves like an extending background. Root opacity/filter effects
also bound it to Blitz's border-box effect bounds (expanded for filters).

The root's computed style supplies the look:

- `--tk-fill`: colour, including `currentColor`; default transparent.
- `border-radius`: four horizontal corner radii, CSS-normalized to fit.
- `--tk-bevel`: inside edge width in CSS pixels; default 0.
- `--tk-bevel-inset`: 1 reverses lighting; default 0.
- `--tk-bevel-base`: uniform lift towards white, 0–1; default 0.
- `--tk-bevel-strength`: lighting strength, 0–1; default 1.

Root attributes:

- `surface-own="false"` omits the root's shape; otherwise it is the first add.
- `surface-join="n"` supplies members' default join radius; default 0.

Group names must be unique within a document: one root per name; the last
registration wins. Any element anywhere in the same document can join named groups with `surface-groups="panel other"`.
Sub-documents use Blitz's default painter. A member's border box and horizontal
radii contribute where Blitz paints it:

- `surface-op="add|cut"`: default add.
- `surface-join="n"`: overrides the root's join radius, in CSS pixels.
- `surface-attach="left|right|top|bottom"`: add only; the member's side touching
  a plain add. Uses an exact rounded outline when a target exists.
- `surface-slant="a"` or `"left right"`: angles from vertical, clamped to ±75°.
  Positive widens the top; negative widens the bottom.
- `surface-animate`: tween a previously present member whose box changed for
  220 ms with cubic ease-out, unless the root resized in the same paint.
  Arrivals/removals snap; unchanged targets keep their clocks. In-flight
  positions snap to device pixels. Only running tweens request another frame.
  A paint gap longer than 220 ms ends a tween at its target without replay.

Geometry is in CSS pixels in the root's border-box space. `locate(member)`
provides the member's physical box and transform; one scale conversion maps
it into this space, and the root's transform places the result in the scene.
Pure translations retain exact attached/slanted builders. For scale/rotation,
the rounded outline is transformed as a general shape; attach and slant are
ignored. A member contributes wherever it would land, in view or not, including
when scrolled out of an ancestor clip. Unrendered members (`display:none`, not
visible, `opacity:0`, or under such an element) contribute nothing, except that
Blitz currently still locates a positioned descendant of a zero-opacity ancestor;
such a descendant can contribute to a visible group.
The group is drawn only when Blitz paints its root: a root that is itself out
of view draws nothing even if a member is visible.

Order is root, plain adds, attached adds, then cuts, in document order.
Wire mutations feed the registry; there is no document scan or after-layout
surface pass. Window and offscreen rendering share the same painter. Per-root
state holds previous shapes and tweens. Removing a root drops its state;
a document paint drops states for unpainted roots. If Blitz never calls the
document root (for example `display:none`), state survives that paint.

The outline and recorded scene are reused while shown shapes and look are
unchanged. Exact rounded builders flatten at 0.02 CSS px
for ordered `geo` union/difference. General joins use round-buffer closing
for adds and opening for cuts, limited to twice the member's join radius.
Buffer arcs have at most 0.01 CSS px sagitta.

The scene fills the outline, then inward edge strips clipped to it. Strips
meet at angle bisectors; width is capped at half each contour's smallest
bounding dimension. Upward outward normals lighten towards white (gain .18),
downward normals darken towards black (gain .45); horizontal normals retain
the base lift. Hole normals reverse. One opacity layer preserves fill alpha.

There are no surface textures, shaders or GPU resources.
Legacy surface styling and geometry attributes are ignored.
