import { createFunctions, type DatabaseReader, type ModelFromSchema, type Id, type User } from "@tokamak/sdk";
import schema from "./schema";

export const { query, mutation, action } = createFunctions(schema);

export const DEFAULT_TITLE = "New thread";
export type Model = ModelFromSchema<typeof schema>;

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
export async function turn(
  { db, user }: { db: DatabaseReader<Model>; user: User },
  runId: Id<"runs">,
  token: string,
) {
  const run = await db.get(runId);
  if (!run || run.status !== "running") throw new Error("Run is no longer running");
  if (!run.token || run.token !== token || (run.owner?.id ?? "local") !== user.id)
    throw new Error("Invalid turn token or owner");
  return run;
}
