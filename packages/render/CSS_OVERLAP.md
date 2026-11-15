# CSS rendering

Blitz paints ordinary backgrounds, borders, shadows, outlines, opacity,
transforms and clipping. The render host does not intercept those styles.

The input host still handles `--tk-overscroll: contain` because this Blitz
release chains otherwise unused wheel deltas. That workaround lives in
`src/input.rs`.
