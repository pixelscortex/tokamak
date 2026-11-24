import { errorText } from "../shared/turn-shared";
import { isFailure, routesLocalContracts, type JsonValue, type LocalContext } from "@tokamak/sdk";
import { turnHooks, type TurnDetails, type TurnHooks, type TurnInfo } from "../contracts";

const HOOK_DEADLINE_MS = 60_000;
const BEFORE_TIMEOUT = "The turn could not start: a before hook timed out.";
const AFTER_TIMEOUT = "Couldn't save this turn's code";

/** Owns the provider list and any hook state for this one turn. */
export function hooksFor(ctx: LocalContext, turn: TurnDetails) {
  const routed = routesLocalContracts(ctx);
  const controller = new AbortController();
  const live: TurnInfo = { ...turn, signal: controller.signal };
  let hooks: readonly TurnHooks[] = [];
  const before = new Map<TurnHooks, JsonValue>();
  let interrupt: ((reason: string) => void) | undefined;

  async function withinDeadline<T>(operation: () => T | Promise<T>, timeout: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          interrupt = (reason) => {
            reject(new Error(reason));
            controller.abort();
          };
          timer = setTimeout(() => interrupt?.(timeout), HOOK_DEADLINE_MS);
        }),
        Promise.resolve().then(operation),
      ]);
    } finally {
      clearTimeout(timer);
      interrupt = undefined;
    }
  }

  return {
    async before(): Promise<string | undefined> {
      try {
        hooks = await withinDeadline(
          () => turnHooks.list(ctx, { signal: controller.signal }),
          BEFORE_TIMEOUT,
        );
        for (const hook of hooks) {
          if (!hook.before) continue;
          const result = await withinDeadline(() => hook.before?.(routed ? turn : live), BEFORE_TIMEOUT);
          if (!isFailure(result)) {
            if (routed && result && "state" in result) before.set(hook, result.state);
            continue;
          }
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
          () =>
            Promise.allSettled(
              hooks.map(async (hook) => {
                const state = before.get(hook);
                return hook.after?.(
                  routed ? (state === undefined ? turn : { ...turn, before: state }) : live,
                );
              }),
            ),
          AFTER_TIMEOUT,
        );
        const failure = results.find((result) => result.status === "rejected");
        if (failure) return routed ? AFTER_TIMEOUT : errorText(failure.reason);
      } catch (cause) {
        return routed ? AFTER_TIMEOUT : errorText(cause);
      }
    },
    stop() {
      if (routed) interrupt?.("The turn was stopped while a hook was running.");
    },
    close() {
      before.clear();
      hooks = [];
    },
  };
}
