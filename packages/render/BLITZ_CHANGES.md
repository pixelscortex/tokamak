# Blitz changes

This branch uses the Blitz fork pinned in Cargo.toml. Its element paint traversal
API (`ElementPainter`, `Piece`, and `ElementPaint::locate`) lets fused groups draw
at the root's background piece using members' paint-space boxes and transforms,
even out of view, inside the normal effect layers and ancestor clips. Icons still use the widget API.
See [BLITZ_FORK.md](BLITZ_FORK.md) for fork rules.
