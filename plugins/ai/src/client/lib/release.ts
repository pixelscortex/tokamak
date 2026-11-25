import { isFailure, type TokamakClient } from "@tokamak/sdk";
import { BEAT_MS } from "../../shared/turn-timing";
import { api } from "./agents";

/** Allow time for the old window's calls to close and its last beat to go stale. */
const TRIES = 4;

/**
 * When this window's local part comes up, this device's turns that it does
 * not run belong to an app that quit or crashed: end them now
 * (`liveness:release`) rather than showing a dead turn until the server's
 * 45-second limit.
 */
export async function releaseOrphanedTurns(client: TokamakClient): Promise<void> {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const turns = await client.action(api.working.list, {});
    if (isFailure(turns)) return;
    const running = turns.map((turn) => turn.turnId);
    const pending = await client.mutation(api.liveness.release, { running });
    // A reconnect can still see calls from the old window while its socket is closing.
    if (pending === 0 && running.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, BEAT_MS));
  }
}
