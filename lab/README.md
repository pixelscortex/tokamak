# Native component lab

Run `bun run ui:lab` from the repository root. This is a separate UI-only
workspace using the same Solid/QuickJS/Blitz/GPU path as the product.
It needs no server, SDK client, credentials or database.

- `src/app.tsx`: the lab as the application shell (rail sections, top bar).
- `src/chat.tsx`, `src/cases.tsx` (Components), `src/surfaces.tsx`,
  `src/stress.tsx`: one view per rail section; `src/kit.tsx`: shared pieces;
  `src/icons.ts`: icon paths (Lucide ISC, Phosphor MIT).
- `src/styles.css`: imports, dark values for the older Button/Input theme and
  base element rules; everything else is Tailwind utilities in the views.
- `src/main.tsx`: mount entry.
- `src/main.rs`: launches with its own title bar (render `WindowOptions`).
- `app.config.json`: native title/window geometry.
- `tests/native.rs`: real control interaction, validation, read-only/disabled
  state, reset/remount/filter and stage-width layout.
- `tests/fused_surface.rs`: surfaces and shell behaviour; ignored GPU tests
  render offscreen captures and the stress benchmark.

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
