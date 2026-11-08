# Native component lab

Run `bun run ui:lab` from the repository root. This is a separate UI-only
workspace using the same Solid/QuickJS/Blitz/GPU path as the product.
It needs no server, SDK client, credentials or database.

- `src/cases.tsx`: catalog and local-state examples.
- `src/styles.css`: independent lab theme/layout, importing shared UI rules.
- `src/main.tsx`: mount entry.
- `src/main.rs`: thin UI-only runtime invocation using a generated context.
- `app.config.json`: native title/window geometry.
- `tests/native.rs`: real control interaction, validation, read-only/disabled
  state, reset/remount/filter and wide/narrow layout.

Implement primitives in `packages/ui`, then add cases here. Include actual
keyboard/focus/editing states and small realistic compositions, not mock controls.
Gallery cards are layout, not a prematurely published Card primitive.

`moon run lab:check lab:test` validates the generated native assets. These
checks do not establish physical IME, VoiceOver, GPU presentation or latency.

Tailwind v4 runs only at build time, with maintained source extraction. The
catalog's responsive grid uses TSX utility classes. Shared sources are declared
using `@source`; use complete static class names rather than interpolated names.
No-op assets retain their mtimes. There is no watch/HMR or production plugin
loader yet; this is the UI-only application of the shared artifact pipeline.
