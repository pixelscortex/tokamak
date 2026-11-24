import { fail, type AuthContext } from "@tokamak/sdk";
import type { Run } from "../contracts";
import { errorText, isSendersDevice } from "../shared/turn-shared";

type Steer = Parameters<Run["onSteer"]>[0];
type Stop = Parameters<Run["onStop"]>[0];
const STEER_REGISTRATION_MS = 500;

const running = new Map<string, ReturnType<typeof turnControl>>();

export function controlFor(turnId: string, auth: AuthContext) {
  const control = running.get(turnId);
  if (!control) return;
  if (!isSendersDevice(control, auth)) throw new Error("Only the sender's device can control this turn");
  return control;
}

/** Bridges separate local calls into the provider's running invocation, on its original device. */
export function turnControl(
  turnId: string,
  auth: AuthContext,
  cancelQuestion?: () => Promise<void>,
  cancelHook?: () => void,
) {
  let steer: Steer | undefined;
  let stop: Stop | undefined;
  let stopRequested = false;
  let stopReady = false;
  let stopSent = false;
  let agentClosed = false;
  let forceKill: (() => Promise<void>) | undefined;
  let forcing: Promise<void> | undefined;
  let resolveForced!: () => void;
  const forcedEnd = new Promise<undefined>((resolve) => (resolveForced = () => resolve(undefined)));
  let steerLine: Promise<unknown> = Promise.resolve();
  // The row can appear before start registers its handlers. Hold early steers briefly and in order;
  // if the provider never registers, return a failure before any text is written to the reply.
  let releaseEarlySteers!: () => void;
  const earlySteers = new Promise<void>((resolve) => (releaseEarlySteers = resolve));
  let registrationTimer: ReturnType<typeof setTimeout> | undefined;

  function releaseSteers() {
    clearTimeout(registrationTimer);
    releaseEarlySteers();
  }

  function sendStop() {
    if (agentClosed || !stop || stopSent) return;
    stopSent = true;
    void Promise.resolve()
      .then(stop)
      .catch(() => {});
  }

  const control = {
    sender: { id: auth.user.id, device: auth.device.id },
    onSteer(handler: Steer) {
      steer = handler;
      releaseSteers();
    },
    onStop(handler: Stop) {
      stop = handler;
      if (stopReady) sendStop();
    },
    steer(text: string, record: () => Promise<unknown>) {
      const delivery = steerLine.then(async () => {
        if (!steer && !agentClosed && !stopRequested) {
          registrationTimer ??= setTimeout(releaseSteers, STEER_REGISTRATION_MS);
          await earlySteers;
        }
        if (agentClosed || stopRequested) return noRunningTurn(turnId);
        const deliver = steer;
        if (!deliver) return fail("NoSteerHandler", { turnId });
        await record();
        // Only clear the window's draft if its text was recorded, even if the provider write fails.
        return await Promise.resolve()
          .then(() => deliver(text))
          .then(
            () => ({ error: null }),
            (cause: unknown) => ({ error: errorText(cause) }),
          );
      });
      steerLine = delivery.catch(() => {});
      return delivery;
    },
    /** Cancel a pending run.ask before interrupting; some providers wait for the answer to proceed. */
    async requestStop() {
      cancelHook?.();
      if (stopRequested) return;
      stopRequested = true;
      releaseSteers();
      try {
        await cancelQuestion?.();
      } finally {
        stopReady = true;
        sendStop();
      }
    },
    async run<T>(start: () => Promise<T>, kill: () => Promise<void>) {
      forceKill = kill;
      // A provider may never settle, even after every program dies. Race its promise, but let
      // any in-progress kill finish before releasing the queue if start settles during the kill.
      try {
        return await Promise.race([start(), forcedEnd]);
      } finally {
        await forcing;
      }
    },
    async forceStop() {
      if (agentClosed || !forceKill) return noRunningTurn(turnId);
      forcing ??= forceKill().then(resolveForced);
      await forcing;
      return null;
    },
    closeAgent() {
      agentClosed = true;
      releaseSteers();
    },
    close() {
      this.closeAgent();
      running.delete(turnId);
    },
  };
  running.set(turnId, control);
  return control;
}

export const noRunningTurn = (turnId: string) => fail("NotRunning", { turnId });
