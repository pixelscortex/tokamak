import { fail, type AuthContext } from "@tokamak/sdk";
import { TURN_ENDED } from "@tokamak/sdk/agent-turn";
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
export function turnControl(turnId: string, auth: AuthContext, cancelQuestion?: () => Promise<void>) {
  let steer: Steer | undefined;
  let linkedSteer = false;
  let finishing = false;
  let stop: Stop | undefined;
  let stopRequested = false;
  let stopReady = false;
  let stopSent = false;
  let closed = false;
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
    if (closed || !stop || stopSent) return;
    stopSent = true;
    void Promise.resolve()
      .then(stop)
      .catch(() => {});
  }

  const control = {
    sender: { id: auth.user.id, device: auth.device.id },
    onSteer(handler: Steer, linked = false) {
      steer = handler;
      linkedSteer = linked;
      releaseSteers();
    },
    onStop(handler: Stop) {
      stop = handler;
      if (stopReady) sendStop();
    },
    steer(text: string, record: (delivery?: "pending" | "delivered" | "failed") => Promise<unknown>) {
      const delivery = steerLine.then(async () => {
        if (!steer && !closed && !stopRequested) {
          registrationTimer ??= setTimeout(releaseSteers, STEER_REGISTRATION_MS);
          await earlySteers;
        }
        if (closed || finishing || stopRequested) return noRunningTurn(turnId);
        const deliver = steer;
        if (!deliver) return fail("NoSteerHandler", { turnId });
        // Record before delivery so even an immediate reaction follows the
        // steer. The live Bun path keeps its original behavior on failure.
        await record(linkedSteer ? "pending" : undefined);
        const result = await Promise.resolve()
          .then(() => deliver(text))
          .then(
            () => ({ error: null }),
            (cause: unknown) => ({ error: errorText(cause) }),
          );
        if (linkedSteer) {
          await record(result.error === null ? "delivered" : "failed");
          if (result.error === TURN_ENDED || result.error === "Local contract channel ended")
            return noRunningTurn(turnId);
        }
        return result;
      });
      steerLine = delivery.catch(() => {});
      return delivery;
    },
    /** Cancel a pending run.ask before interrupting; some providers wait for the answer to proceed. */
    async requestStop() {
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
        if (linkedSteer) {
          finishing = true;
          await steerLine;
        }
      }
    },
    async forceStop() {
      if (closed || !forceKill) return noRunningTurn(turnId);
      forcing ??= forceKill().then(resolveForced);
      await forcing;
      return null;
    },
    close() {
      closed = true;
      releaseSteers();
      running.delete(turnId);
    },
  };
  running.set(turnId, control);
  return control;
}

export const noRunningTurn = (turnId: string) => fail("NotRunning", { turnId });
