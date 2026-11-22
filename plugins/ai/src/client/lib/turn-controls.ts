import { isFailure, type Id, type TokamakClient } from "@tokamak/sdk";
import { state } from "@tokamak/sdk/client";
import type { DraftSubmission } from "plugin:chat/client";
import type { TurnView } from "../../server/_functions";
import { errorText } from "../../shared/turn-shared";
import { api, notice, reasonLine, unavailable } from "./agents";
import { runsAgentHere, threadChoices, toStored } from "./choices";

export const localActiveTurn = state<TurnView | null>(null);

export function activeFor(threadId: string | undefined) {
  const turn = localActiveTurn();
  return turn?.threadId === threadId ? turn : null;
}

export async function submit(client: TokamakClient, { threadId, text, intent }: DraftSubmission) {
  if (!client.hasLocal || !(await runsAgentHere(client, threadId))) return false;
  const holder = await client.query(api.turns.pending, { threadId });
  if (!holder) return false;
  notice.set(undefined);
  if (holder.state !== "queued" && intent === "steer") {
    const result = await client.local(api.run.steer, { turnId: holder._id, text });
    if (isFailure(result)) {
      if (result.kind === "NoSteerHandler")
        throw new Error("This agent doesn't accept follow-ups during a turn. Use Cmd+Enter to queue.");
      if (!(await client.query(api.turns.pending, { threadId }))) return false;
      throw new Error("This turn is running in another window or is ending.");
    }
    if (result.error) notice.set(`The agent could not receive the steer: ${result.error}`);
  } else {
    // A queued turn keeps the thread's choices as they are now.
    const picked = await threadChoices(client, threadId, false);
    if (!picked) throw new Error("Choose an agent before queuing a message.");
    const problem = unavailable(picked.agent);
    if (problem) throw new Error(problem);
    const { model, ...settings } = toStored(picked);
    const result = await client.mutation(api.turns.enqueue, {
      threadId,
      text,
      model: model ?? "default",
      ...settings,
    });
    if (isFailure(result)) throw new Error(reasonLine(result.kind, result.data.agent));
  }
  return true;
}

export async function stopTurn(client: TokamakClient, turnId: Id<"turns">) {
  try {
    if (isFailure(await client.local(api.run.stop, { turnId })))
      notice.set("This turn is running in another window or has ended.");
  } catch (cause) {
    notice.set(`The turn could not stop: ${errorText(cause)}`);
  }
}

export async function forceStopTurn(client: TokamakClient, turnId: Id<"turns">) {
  try {
    const result = await client.local(api.run.forceStop, { turnId });
    if (isFailure(result))
      notice.set(
        result.kind === "NotRunning"
          ? "This turn is running in another window or has ended."
          : "Still stopping…",
      );
  } catch (cause) {
    notice.set(`The turn could not stop: ${errorText(cause)}`);
  }
}
