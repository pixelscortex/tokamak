import { isFailure, type LocalContext } from "@tokamak/sdk";
import { turnHooks, type TurnHooks, type TurnInfo } from "../contracts";
import { errorText } from "../shared/turn-shared";

const HOOK_DEADLINE_MS = 60_000;
const BEFORE_TIMEOUT = "The turn could not start: a before hook timed out.";
const AFTER_TIMEOUT = "A turn after hook timed out.";

export function hooksFor(ctx: LocalContext, turn: Omit<TurnInfo, "signal">) {
  const controller = new AbortController();
  const input: TurnInfo = { ...turn, signal: controller.signal };
  const notices = new Set<string>();
  let beforeCalls: AbortController | undefined;
  let interrupt: ((reason: string) => void) | undefined;

  function cancel(reason: string) {
    interrupt?.(reason);
    beforeCalls?.abort();
    controller.abort();
  }

  function notice() {
    return notices.size ? [...notices].join("\n") : undefined;
  }

  async function withinDeadline<T>(operation: () => T | Promise<T>, timeout: () => string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          interrupt = (reason) => reject(new Error(reason));
          timer = setTimeout(() => cancel(timeout()), HOOK_DEADLINE_MS);
        }),
        Promise.resolve().then(operation),
      ]);
    } finally {
      clearTimeout(timer);
      interrupt = undefined;
    }
  }

  const lookup = (signal = input.signal) =>
    turnHooks.list(ctx, {
      signal,
      inputSignal: input.signal,
      onUnavailable: ({ message, notice }) => notices.add(notice ?? message),
    });

  return {
    async before(): Promise<string | undefined> {
      const calls = (beforeCalls = new AbortController());
      try {
        const timeout = () => BEFORE_TIMEOUT;
        const hooks = await withinDeadline(() => lookup(calls.signal), timeout);
        for (const hook of hooks) {
          if (!hook.before) continue;
          const result = await withinDeadline(() => hook.before?.(input), timeout);
          if (!isFailure(result)) continue;
          const data = result.data;
          if (typeof data === "object" && data && "reason" in data && typeof data.reason === "string") {
            return data.reason;
          }
          return `The turn could not start: ${result.kind}`;
        }
      } catch (cause) {
        return errorText(cause);
      } finally {
        beforeCalls = undefined;
      }
    },
    async after(): Promise<string | undefined> {
      const pending = new Set<TurnHooks>();
      try {
        // Every after hook starts together and has the same deadline.
        await withinDeadline(
          async () => {
            // Refresh the route for providers rebuilt while the agent ran.
            for (const hook of await lookup()) if (hook.after) pending.add(hook);
            if (input.signal.aborted) return;
            await Promise.all(
              [...pending].map(async (hook) => {
                try {
                  await hook.after?.(input);
                } catch (cause) {
                  if (!input.signal.aborted) notices.add(errorText(cause));
                } finally {
                  pending.delete(hook);
                }
              }),
            );
          },
          () =>
            [...new Set([...pending].map((hook) => hook.afterTimeoutNotice ?? AFTER_TIMEOUT))].join("\n") ||
            AFTER_TIMEOUT,
        );
      } catch (cause) {
        notices.add(errorText(cause));
      }
      return notice();
    },
    notice,
    stopBefore() {
      // This cancels routed before calls. Bun still hands hooks the live deadline signal.
      beforeCalls?.abort();
    },
    cancel() {
      cancel("The turn ended while a hook was running.");
    },
  };
}
