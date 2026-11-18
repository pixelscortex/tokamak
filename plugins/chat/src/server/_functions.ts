import {
  createFunctions,
  type DatabaseReader,
  type ModelFromSchema,
  type Id,
  type QueryContext,
} from "@tokamak/sdk";
import schema from "./schema";

export const { query, mutation, action } = createFunctions(schema);

export const DEFAULT_TITLE = "New thread";
export type Model = ModelFromSchema<typeof schema>;

export async function usesMachineLink(ctx: Pick<QueryContext<Model>, "user" | "providers">) {
  // The local identity is assigned by the host, never chosen by a client.
  return ctx.user.id !== "local" && (await ctx.providers("chat.backend")).length === 0;
}

export async function thread(db: DatabaseReader<Model>, id: Id<"threads">) {
  const value = await db.get(id);
  if (!value) throw new Error("Thread no longer exists");
  return value;
}

export function nonempty(text: string) {
  const value = text.trim();
  if (!value) throw new Error("Text must not be empty");
  return value;
}

// Backend writes carry a capability issued only to the action owning this turn.
export async function turn(db: DatabaseReader<Model>, runId: Id<"runs">, token: string, owner?: string) {
  const run = await db.get(runId);
  if (!run || run.status !== "running") throw new Error("Run is no longer running");
  if (!run.token || run.token !== token) throw new Error("Invalid turn token");
  if (run.machine) {
    if (owner !== run.owner) throw new Error("Run does not belong to you");
    const machine = await db.get(run.machine);
    if (!machine || machine.leaseUntil <= Date.now() || machine.epoch !== run.machineEpoch)
      throw new Error("Machine lease expired");
  }
  return run;
}
