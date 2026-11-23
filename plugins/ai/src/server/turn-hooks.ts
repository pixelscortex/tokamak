import { errorText } from "../shared/turn-shared";
import { isFailure, type LocalContext } from "@tokamak/sdk";
import { turnHooks, type TurnHooks, type TurnInfo } from "../contracts";

const HOOK_DEADLINE_MS = 60_000;
const BEFORE_TIMEOUT = "The turn could not start: a before hook timed out.";
const AFTER_TIMEOUT = "Couldn't save this turn's code";

/** Keeps the provider list and live turn info for the two phases of one turn. */
export function hooksFor(ctx: LocalContext, turn: Omit<TurnInfo, "signal">) {
  const controller = new AbortController();
  const info: TurnInfo = { ...turn, signal: controller.signal };
  let hooks: readonly TurnHooks[] = [];

  async function withinDeadline<T>(operation: () => T | Promise<T>, timeout: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(timeout));
            controller.abort();
          }, HOOK_DEADLINE_MS);
        }),
        Promise.resolve().then(operation),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async before(): Promise<string | undefined> {
      try {
        hooks = await withinDeadline(() => turnHooks.list(ctx), BEFORE_TIMEOUT);
        for (const hook of hooks) {
          if (!hook.before) continue;
          const result = await withinDeadline(() => hook.before?.(info), BEFORE_TIMEOUT);
          if (!isFailure(result)) continue;
          const data = result.data;
          if (typeof data === "object" && data && "reason" in data && typeof data.reason === "string") {
            return data.reason;
          }
          return `The turn could not start: ${result.kind}`;
        }
      } catch (cause) {
        return errorText(cause);
      }
    },
    async after(): Promise<string | undefined> {
      try {
        // After hooks start together, so they share one deadline.
        const results = await withinDeadline(
          () => Promise.allSettled(hooks.map(async (hook) => hook.after?.(info))),
          AFTER_TIMEOUT,
        );
        const failure = results.find((result) => result.status === "rejected");
        if (failure) return errorText(failure.reason);
      } catch (cause) {
        return errorText(cause);
      }
    },
  };
}
