import { createEffect } from "solid-js";
import type { SignIn } from "./api";
import { cancelSignInReturn, hasDesktopSignIn, listenForSignInReturn } from "./desktop";

const returns = {
  anthropic: { port: 54545, path: "/callback" },
  openai: { port: 1455, path: "/auth/callback" },
};
const lifetime = 15 * 60_000;

/** One listener per active dialog. A refused return can be retried within the original lifetime. */
export function watchSignInReturn(
  active: () => SignIn | undefined,
  finish: (address: string) => Promise<boolean>,
): void {
  createEffect(active, (signIn) => {
    if (!signIn || signIn.expired || !hasDesktopSignIn()) return;
    const target = returns[signIn.company];
    const deadline = signIn.startedAt + lifetime;
    let stopped = false;
    let pending: string | undefined;
    async function listen() {
      while (!stopped) {
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0) return;
        const requestId = crypto.getRandomValues(new Uint32Array(4)).join("-");
        pending = requestId;
        const result = await listenForSignInReturn({ ...target, requestId, timeoutMs });
        pending = undefined;
        if (stopped || result.status !== "returned" || (await finish(result.address))) return;
      }
    }
    // This enhancement can fail without taking away the paste path.
    void listen().catch(() => {});
    return () => {
      stopped = true;
      if (pending !== undefined) void cancelSignInReturn(target.port, pending).catch(() => {});
    };
  });
}
