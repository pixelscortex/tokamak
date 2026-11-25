/// <reference types="node" />
import { action, TIMED_OUT, within, type AuthContext, type Id } from "@tokamak/sdk";
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
  readonly skipAfter: () => void;
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
export const list = action({
  on: "caller",
  handler: async (ctx) =>
    mine(ctx.auth).map(([turnId, { threadId, agent }]) => ({ turnId, threadId, agent })),
});

/** How long Stop and quit waits for the agents' programs to go once they are force-stopped. */
const AFTER_FORCE_MS = 3_000;

/**
 * Stops active agents and skips any remaining after hooks for the caller.
 * Waits for the turns' rows to settle, preserving outcomes already decided.
 * An agent still running after the Force stop delay has its programs killed.
 * Resolves with how many turns were handled.
 */
export const stopAll = action({
  on: "caller",
  handler: async (ctx) => {
    await ctx.runMutation(api.turns.stopQueued, {});
    const turns = mine(ctx.auth);
    await Promise.all(
      turns.map(async ([turnId, { control, skipAfter }]) => {
        const stopping = await control.requestStop(() =>
          ctx.runMutation(api.turns.requestStop, { turnId }).catch(() => {}),
        );
        if (!stopping) skipAfter();
      }),
    );
    const ended = Promise.all(turns.map(([, turn]) => turn.ended));
    if ((await within(ended, FORCE_STOP_MS)) !== TIMED_OUT) return turns.length;
    await Promise.all(turns.map(([, { control }]) => control.forceStop()));
    await within(ended, AFTER_FORCE_MS);
    return turns.length;
  },
});
