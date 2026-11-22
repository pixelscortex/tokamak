import type { TokamakClient } from "@tokamak/sdk";
import { BEAT_MS } from "../../shared/turn-timing";
import { api } from "./agents";

/** A relaunch asks a few beats long: turns that beat until the quit need that long to fall silent. */
const TRIES = 4;

/**
 * When this window's local part comes up, this device's turns that it does
 * not run belong to an app that quit or crashed: end them now
 * (`liveness:release`) rather than showing a dead turn until the server's
 * 45-second limit.
 */
export async function releaseOrphanedTurns(client: TokamakClient): Promise<void> {
  if (!client.hasLocal) return;
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const running = (await client.local(api.working.list, {})).map((turn) => turn.turnId);
    if ((await client.mutation(api.liveness.release, { running })) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, BEAT_MS));
  }
}
