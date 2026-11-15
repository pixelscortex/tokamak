import { afterDelay } from "@tokamak/render";
import { createEffect, getOwner, onCleanup, runWithOwner, type Accessor } from "solid-js";
import type { TokamakClient } from "@tokamak/sdk";
import { api } from "../../../plugins/chat/client";

export function useRunRecovery(client: TokamakClient, running: Accessor<boolean>, setError: (error: string) => void) {
  const owner = getOwner();
  let sweep: { stop: () => void; schedule: () => void } | undefined;
  let schedulingErrorLogged = false;
  onCleanup(() => sweep?.stop());

  createEffect(() => {
    if (!running()) {
      sweep?.stop();
      sweep = undefined;
      return;
    }
    if (sweep) {
      sweep.schedule();
      return;
    }
    let stopped = false;
    let recovering = false;
    let cancelDelay: (() => void) | undefined;

    function schedule() {
      if (stopped || recovering || cancelDelay) return;
      try {
        cancelDelay = runWithOwner(owner, () => afterDelay(30_000, () => {
          cancelDelay = undefined;
          void recover();
        }));
      } catch (cause) {
        if (!schedulingErrorLogged) {
          const message = `Could not schedule stale-run recovery: ${String(cause)}`;
          const logger = (globalThis as { console?: { error: (message: string) => void } }).console;
          if (logger) logger.error(message);
          else setError(message);
          schedulingErrorLogged = true;
        }
      }
    }

    async function recover() {
      recovering = true;
      try {
        await client.mutation(api.runs.recover, {});
      } catch (cause) {
        if (!stopped) setError(String(cause));
      } finally {
        recovering = false;
        schedule();
      }
    }

    sweep = { stop: () => { stopped = true; cancelDelay?.(); }, schedule };
    void recover();
  });
}
