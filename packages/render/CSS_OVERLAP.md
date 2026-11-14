# CSS and fused groups

Blitz paints ordinary backgrounds, borders, shadows, outlines, opacity,
transforms and clipping. The render host does not intercept those styles.

Fused groups use a separate `<tk-surface>` background layer. Its root's
`--tk-fill`, `border-radius` and `--tk-bevel*` properties control one combined
outline, including member adds and cuts. There is no separate surface border:
the bevel is the only lit band. See [SURFACES.md](SURFACES.md).

The input host still handles `--tk-overscroll: contain` because this Blitz
release chains otherwise unused wheel deltas. That workaround lives in
`src/input.rs` and is independent of surface painting.
