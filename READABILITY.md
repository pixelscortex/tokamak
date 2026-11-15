# Backend readability verification

Baseline (workspace Clippy, all features, libraries and binaries):

- `too_many_lines`: 13 warnings.
- `excessive_nesting`: 29 warnings.
- Oxlint: 48 warnings, no errors.
- jscpd: 6 clones, including 4 Rust clones (32 duplicated Rust lines).

The explicitly excluded `app/` and `packages/render/` manifests still need
`[lints] workspace = true` from their owning agent. The other five workspace
members inherit the advisory Rust lints. Moon advisory tasks allow failure.
