# Where our surface features overlap with ordinary CSS

We draw some things ourselves that CSS also has a word for. This file keeps
track of each overlap, so that when Blitz gains or improves a feature we can
decide to hand it back, keep ours, or translate one into the other.

Rule for names: where CSS already has the concept, authors write the CSS
word (`bg-*`, `border`, `rounded-*`, `shadow-*`, `ring-*`, `opacity-*`). We
add our own words only for things CSS has no concept of (`bevel-*`, lights,
grain). There must never be two ways to write the same thing.

Checked against Blitz 0.3.0-beta.4 on 2026-11-11.

| What | CSS word | Does Blitz draw it | What we do today | Revisit when |
|---|---|---|---|---|
| Fill colour of a plate | `background-color` (`bg-*`) | Yes | We take it over inside a region: the build copies the colour into our fill and Blitz is told not to paint it, so the fill, bevel and elevation are drawn as one plate. By default the plate paints itself at the element's own place (the fork change, TKM-77); a sheet draws it below the region's content. | Blitz can draw a lit edge and elevation itself |
| Rounded corners | `border-radius` (`rounded-*`) | Yes | We read the computed radius; nothing of ours to write. | Never; this is the right split |
| Border line | `border` | Yes. On a plate it depends on the painter (checked 2026-11-11): a self-painting plate is drawn after its element's border and covers it; a sheet's plate is below the border, which shows. | Left to Blitz. It is not lit and does not follow merged shapes. `Surface` has its own lit hairline for big surfaces. | We add a rim (lit edge line); then decide whether `border` on a plate becomes that |
| Drop shadow, contact shadow | `box-shadow` (`shadow-*`) | Yes, outside the element's box (checked: tight, soft and coloured shadows show around plates) | Left to Blitz. It is a blurred copy of the element's own box: it does not know heights, neighbours or merged shapes. | We build a height-aware contact shadow; then `shadow-*` either stays Blitz's or is translated |
| Glow around an element | coloured `box-shadow` | Yes (checked: a blue glow shows around a plate) | Left to Blitz. It lights nothing: neighbours do not pick up the colour. | Placed lights exist |
| Focus ring | `outline`, `ring-*` | Not checked with plates | Left to Blitz | Before building inputs |
| Fading | `opacity` | Yes for content | A self-painting plate (the default) fades with its element and its ancestors. In a sheet only the plate's own `opacity` applies (a limit of the sheet). | Never for self-painting; the sheet keeps its limit |
| Background blur | `backdrop-filter` | Parsed, but the Vello backend ignores it | Nothing | The backend implements filters, or we build our own |
| Softer corner shape | `corner-shape` (new in CSS, not widely available) | Not checked | Nothing; set aside by the owner for now | If the look is wanted |
| Edge thickness (a darker strip under the face, a faint line all round) | A bottom `border` over the background plus an inset `ring` (the common "3D button" recipe) | Yes, but only when Blitz also paints the background (a gradient, for example). When our shader paints the fill, the plate covers the border and the inset ring (checked 2026-11-11). | Ours: `elevation-<n>`, `sink-<n>` and `pressed`, drawn by the shader (the hairline only without a bevel) | An element can let Blitz paint its border above our plate, or we translate `border-b-*` on a plate into the elevation strip |
| Lit edge (bevel) | none | No | Ours: `bevel`, `bevel-<n>`, `bevel-sharp` (the default), `bevel-soft`, `bevel-tilt-<degrees>`, `raised`, `recessed` | n/a |
| Lights, grain, brushed surface | none | No | Experiments only | n/a |
