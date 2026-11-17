import { createEffect, onCleanup, type Accessor } from "solid-js";
import type { TokamakClient } from "@tokamak/sdk";
import { api } from "../api";

/** While any run is live, observe runs every 30 s so the server can settle one whose agent died. */
export function useRunRecovery(
  client: TokamakClient,
  running: Accessor<boolean>,
  setError: (error: string) => void,
  interval = 30_000,
) {
  let sweep: { stop: () => void } | undefined;
  onCleanup(() => sweep?.stop());

  createEffect(running, (live) => {
    if (!live) {
      sweep?.stop();
      sweep = undefined;
      return;
    }
    if (sweep) return;
    const sweepId = `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    let tick = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function observe() {
      try {
        await client.mutation(api.runs.observe, { sweepId, tick: tick++ });
      } catch (cause) {
        if (!stopped) setError(String(cause));
      }
      if (!stopped) timer = setTimeout(() => void observe(), interval);
    }

    sweep = {
      stop: () => {
        stopped = true;
        clearTimeout(timer);
      },
    };
    void observe();
  });
}
