/**
 * Quitting the desktop app while a plugin still has work on this computer.
 * A plugin registers a check from its window code; when the person quits,
 * the app asks every check. If any answers with a blocker, the app asks
 * first ("Claude is still working in 1 thread · Stop and quit · Cancel"),
 * and Stop and quit runs each blocker's `stop` before the app closes:
 *
 * ```ts
 * import { onQuit } from "@tokamak/sdk/client";
 * onQuit(async () =>
 *   (await running()).length ? { message: "Claude is still working in 1 thread", stop: stopAll } : undefined,
 * );
 * ```
 */
import { TIMED_OUT, within } from "./src/within";

export interface QuitBlocker {
  /** One line naming what would be lost, as the dialog shows it. */
  readonly message: string;
  /** Ends the work cleanly; the app quits once every blocker's stop has settled. */
  stop(): Promise<unknown>;
}

export type QuitCheck = () => QuitBlocker | undefined | Promise<QuitBlocker | undefined>;

// Kept on globalThis: the app and every plugin bundle must reach the same checks.
const KEY = Symbol.for("tokamak.quitChecks");

function checks(): Set<QuitCheck> {
  const scope = globalThis as typeof globalThis & { [KEY]?: Set<QuitCheck> };
  return (scope[KEY] ??= new Set());
}

/** Registers a check the app runs when the person quits; returns the function that removes it. */
export function onQuit(check: QuitCheck): () => void {
  checks().add(check);
  return () => void checks().delete(check);
}

/**
 * For the app: every blocker the registered checks report. A check that
 * throws or does not answer within `ms` blocks nothing, so a broken plugin
 * cannot stop the person from quitting.
 */
export async function quitBlockers(ms = 2_000): Promise<QuitBlocker[]> {
  const answers = await Promise.all(
    [...checks()].map(async (check) => {
      const answer = await within(
        Promise.resolve()
          .then(check)
          .catch(() => undefined),
        ms,
      );
      return answer === TIMED_OUT ? undefined : answer;
    }),
  );
  return answers.filter((answer): answer is QuitBlocker => answer !== undefined);
}
