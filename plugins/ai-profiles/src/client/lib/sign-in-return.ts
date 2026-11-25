import { createEffect, createSignal, untrack } from "solid-js";
import type { SignIn } from "./api";
import { COMPANIES, returnPath, returnPort } from "./companies";
import { cancelSignInReturn, hasDesktopSignIn, listenForSignInReturn } from "./desktop";
const lifetime = 15 * 60_000;

/** Finish returns true when the sign-in can still accept a retry. */
export function watchSignInReturns(
  waiting: () => readonly SignIn[],
  finish: (signIn: SignIn, address: string) => Promise<boolean>,
): (id: string) => boolean {
  // Each company's return address is written once, in `companies.ts`; its port and path come from there.
  const watching = COMPANIES.map((company) => {
    const [listening, setListening] = createSignal<string>();
    // Each company has one port. If several sign-ins are waiting, listen for the newest.
    const newest = () =>
      waiting().reduce<SignIn | undefined>((latest, signIn) => {
        if (signIn.company !== company || signIn.expired) return latest;
        return !latest || signIn.startedAt >= latest.startedAt ? signIn : latest;
      }, undefined);
    createEffect(
      () => newest()?.id,
      (id) => {
        setListening(undefined);
        const signIn = untrack(newest);
        if (!id || !signIn || !hasDesktopSignIn()) return;
        const expectedState = URL.canParse(signIn.link)
          ? new URL(signIn.link).searchParams.get("state")
          : null;
        if (!expectedState) return;
        const port = returnPort(company);
        const path = returnPath(company);
        const deadline = signIn.startedAt + lifetime;
        let pending: string | undefined;
        let stopped = false;
        async function listen(signIn: SignIn, state: string) {
          while (!stopped) {
            const timeoutMs = deadline - Date.now();
            if (timeoutMs <= 0) return;
            const requestId = crypto.getRandomValues(new Uint32Array(4)).join("-");
            pending = requestId;
            setListening(id);
            const result = await listenForSignInReturn({
              port,
              path,
              expectedState: state,
              requestId,
              timeoutMs,
            });
            pending = undefined;
            if (stopped) return;
            setListening(undefined);
            if (result.status !== "returned" || !(await finish(signIn, result.address))) return;
          }
        }
        // IPC failure leaves the user the same paste flow as a plain browser.
        void listen(signIn, expectedState).catch(() => {
          pending = undefined;
          if (!stopped) setListening(undefined);
        });
        return () => {
          stopped = true;
          if (pending !== undefined) void cancelSignInReturn(port, pending).catch(() => {});
        };
      },
    );
    return listening;
  });
  return (id) => watching.some((listening) => listening() === id);
}
