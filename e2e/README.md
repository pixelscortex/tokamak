# Retired Todo regression acceptance

Run `CARGO_BUILD_JOBS=2 moon run :e2e` (or `bun run e2e`).
The task depends on `app:test`, which builds the original Todo sources from
`app/tests/fixtures/todo` and retains their native/Solid/compiler regressions.

| Scenario | Automated evidence |
| --- | --- |
| Add/toggle/delete | `app/tests/native.rs` drives the retired fixture's UI and real SDK/backend. |
| Two independent clients | `run.ts` opens two WebSocket SDK connections, subscribes **both**, waits for both initial results, and requires both to receive another client's committed add. |
| Persistence | `app/tests/e2e.rs` writes through the actual SDK/native connection, awaits shutdown, reopens the same SurrealKV folder, checks exact rows and awaits shutdown again. |
| Headless shared storage | `run.ts` starts `tokamak` with `app/tests/fixtures/todo/dist/bundle.js` on the released folder and compares exact rows over WebSocket. |
| Endless-loop recovery | A separately bundled test-only SDK feature loops on CPU. A one-worker real headless function service must report the wall-clock budget error, then complete the very next mutation on the same connection. |

No raw DB writes, alternate Todo schema, auth bypass, foreground simulation,
screenshots or committed evidence. Temporary data is under ignored `target/`;
the runner owns and cleans each process and directory, never application data.
An unknown mutation outcome fails rather than retrying the mutation.

## Manual macOS checklist (not automated proof)

- Run `bun run ui:lab`. Confirm a physical native component catalog renders.
- Exercise controlled/uncontrolled/invalid/read-only inputs and action/toggle/disabled buttons.
- Use Tab/Shift-Tab, Enter and Space to operate real controls; check focus visibility.
- Enter composed/non-Latin text with the actual system IME; check no premature
  submission during composition and correct final text.
- Reset/filter the examples and verify native remount and focus behavior.
- The lab state is local; persisted Todo behavior is retained only in test fixtures.
- Record pass/fail outside source control. Native document tests do **not** prove
  foreground presentation, physical mouse/keyboard or system IME behavior.

Record final bytes from the existing `moon run :size` task separately. No size
threshold or fabricated baseline is part of this suite.

Historical pre-standalone measurement from `CARGO_BUILD_JOBS=2 moon run :size` on
`aarch64-apple-darwin`: desktop **46,191,600 bytes**, headless **39,542,368
bytes**. This is not a current-source measurement or claimed before/after delta;
the integration owner independently reruns it.
