# Native component lab

Run `bun run ui:lab` from the repository root. This is a separate UI-only
workspace using the same Solid/QuickJS/Blitz/GPU path as the product.
It needs no server, SDK client, credentials or database.

- `src/cases.tsx`: catalog and local-state examples.
- `src/styles.css`: independent lab theme/layout, importing shared UI rules.
- `src/main.tsx`: mount entry.
- `src/main.rs`: thin `runtime::client::run_ui` host configuration.
- `tests/native.rs`: real control interaction, validation, read-only/disabled
  state, reset/remount/filter and wide/narrow layout.

Implement primitives in `packages/ui`, then add cases here. Include actual
keyboard/focus/editing states and small realistic compositions, not mock controls.
Gallery cards are layout, not a prematurely published Card primitive.

`moon run lab:check lab:test` validates the generated native assets. These
checks do not establish physical IME, VoiceOver, GPU presentation or latency.

Tailwind remains build-only. TSX utility scanning, deterministic no-op asset
publication and generated context/bootstrap ergonomics are rebuilt in TKM-41;
this step retains the existing @apply integration.
