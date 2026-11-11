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
| Fill colour of a plate | `background-color` (`bg-*`) | Yes | We take it over inside a region: the build copies the colour into our fill and Blitz is told not to paint it. Needed so the bevel is not covered. | An element can paint our plate at its own place (the fork change, TKM-77) |
| Rounded corners | `border-radius` (`rounded-*`) | Yes | We read the computed radius; nothing of ours to write. | Never; this is the right split |
| Border line | `border` | Yes, as a flat line above the plate | Left to Blitz. It is not lit and does not follow merged shapes. `Surface` has its own lit hairline for big surfaces. | We add a rim (lit edge line); then decide whether `border` on a plate becomes that |
| Drop shadow, contact shadow | `box-shadow` (`shadow-*`) | Yes, outside the element's box (checked: tight, soft and coloured shadows show around plates) | Left to Blitz. It is a blurred copy of the element's own box: it does not know heights, neighbours or merged shapes. | We build a height-aware contact shadow; then `shadow-*` either stays Blitz's or is translated |
| Glow around an element | coloured `box-shadow` | Yes (checked: a blue glow shows around a plate) | Left to Blitz. It lights nothing: neighbours do not pick up the colour. | Placed lights exist |
| Focus ring | `outline`, `ring-*` | Not checked with plates | Left to Blitz | Before building inputs |
| Fading | `opacity` | Yes for content | A plate's own `opacity` is applied by us; a parent's is not (limit of the sheet). | The fork change (TKM-77) |
| Background blur | `backdrop-filter` | Parsed, but the Vello backend ignores it | Nothing | The backend implements filters, or we build our own |
| Softer corner shape | `corner-shape` (new in CSS, not widely available) | Not checked | Nothing; set aside by the owner for now | If the look is wanted |
| Lit edge (bevel) | none | No | Ours: `bevel-*`, `raised`, `recessed` | n/a |
| Lights, grain, brushed surface | none | No | Experiments only | n/a |
