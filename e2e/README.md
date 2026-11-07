# Todo acceptance

Run `CARGO_BUILD_JOBS=2 moon run :e2e` (or `bun run e2e`).
The task depends on the existing `app:test`; its 14 native behavior assertions,
Solid lifecycle checks and compiler regressions remain unchanged.

| Scenario | Automated evidence |
| --- | --- |
| Add/toggle/delete | Existing `app/tests/native.rs` drives the production UI bundle's SDK in-process against the production Todo bundle. |
| Two independent clients | `run.ts` opens two WebSocket SDK connections, subscribes **both**, waits for both initial results, and requires both to receive another client's committed add. |
| Persistence | `app/tests/e2e.rs` writes through the actual SDK/native connection, awaits shutdown, reopens the same SurrealKV folder, checks exact rows and awaits shutdown again. |
| Headless shared storage | `run.ts` starts the real `tokamak` executable with the production `app/dist/bundle.js` on that released folder and compares the full native snapshot, including IDs and creation times, over WebSocket. |
| Endless-loop recovery | A separately bundled test-only SDK feature loops on CPU. A one-worker real headless function service must report the wall-clock budget error, then complete the very next mutation on the same connection. |

No raw DB writes, alternate Todo schema, auth bypass, foreground simulation,
screenshots or committed evidence. Temporary data is under ignored `target/`;
the runner owns and cleans each process and directory, never application data.
An unknown mutation outcome fails rather than retrying the mutation.

## Manual macOS checklist (not automated proof)

- Run `bun run app`. Confirm a physical native window and both Todo lists render.
- Use the mouse to focus the input, add, toggle and remove tasks; verify both views.
- Use Tab/Shift-Tab, Enter and Space to operate real controls; check focus visibility.
- Enter composed/non-Latin text with the actual system IME; check no premature
  submission during composition and correct final text.
- Leave a named task, close the native window, wait for the process to exit,
  reopen with `bun run app`, and confirm the task and completion state persist.
- Record pass/fail outside source control. Native document tests do **not** prove
  foreground presentation, physical mouse/keyboard or system IME behavior.

Record final bytes from the existing `moon run :size` task separately. No size
threshold or fabricated baseline is part of this suite.

Final local measurement from `CARGO_BUILD_JOBS=2 moon run :size` on
`aarch64-apple-darwin`: desktop **46,191,600 bytes**, headless **39,542,368
bytes**. This is a current-source measurement, not a claimed before/after delta;
the integration owner independently reruns it.
