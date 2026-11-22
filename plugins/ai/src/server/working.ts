/// <reference types="node" />
import { local, TIMED_OUT, within, type AuthContext, type Id } from "@tokamak/sdk";
import { isSendersDevice } from "../shared/turn-shared";
import { FORCE_STOP_MS } from "../shared/turn-timing";
import type { turnControl } from "./controls";
import { api } from "./_generated/api";

/**
 * The turns this computer's local part is running right now, for quitting the
 * app: the window asks `working:list` when the person quits, and Stop and quit
 * calls `working:stopAll`. Only turns that really run here count, not rows
 * left behind by an app that crashed (the server interrupts those).
 */

interface Working {
  readonly threadId: string;
  readonly agent: string;
  readonly control: ReturnType<typeof turnControl>;
  readonly ended: Promise<void>;
}

const working = new Map<Id<"turns">, Working>();

/** Counts the turn as running here until the returned function runs, once its row has ended. */
export function workingOn(turnId: Id<"turns">, turn: Omit<Working, "ended">): () => void {
  let end!: () => void;
  working.set(turnId, { ...turn, ended: new Promise<void>((resolve) => (end = resolve)) });
  return () => {
    working.delete(turnId);
    end();
  };
}

function mine(auth: AuthContext) {
  return [...working].filter(([, turn]) => isSendersDevice(turn.control, auth));
}

/** Each turn running on this computer for the caller: its thread and the agent's name. */
export const list = local({
  handler: async (ctx) =>
    mine(ctx.auth).map(([turnId, { threadId, agent }]) => ({ turnId, threadId, agent })),
});

/** How long Stop and quit waits for the agents' programs to go once they are force-stopped. */
const AFTER_FORCE_MS = 3_000;

/**
 * Stops every turn running here for the caller, as Stop does, and waits for
 * their rows to end ("Stopped", replies kept). An agent that has not ended
 * after the Force stop delay has its programs killed, so quitting leaves no
 * agent process behind. Resolves with how many turns it stopped.
 */
export const stopAll = local({
  handler: async (ctx) => {
    await ctx.runMutation(api.turns.stopQueued, {});
    const turns = mine(ctx.auth);
    await Promise.all(
      turns.map(async ([turnId, { control }]) => {
        await ctx.runMutation(api.turns.requestStop, { turnId }).catch(() => {});
        await control.requestStop();
      }),
    );
    const ended = Promise.all(turns.map(([, turn]) => turn.ended));
    if ((await within(ended, FORCE_STOP_MS)) !== TIMED_OUT) return turns.length;
    await Promise.all(turns.map(([, { control }]) => control.forceStop()));
    await within(ended, AFTER_FORCE_MS);
    return turns.length;
  },
});
