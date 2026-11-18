import {
  createFunctions,
  type DatabaseReader,
  type Doc,
  type ModelFromSchema,
  type Id,
  type User,
} from "@tokamak/sdk";
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

export const RELAY_LIFETIME_MS = 65_000;

export function expired(run: Doc<Model, "runs">, now = Date.now()) {
  return run.status === "running" && run.expiresAt !== undefined && run.expiresAt <= now;
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
  if (expired(run)) throw new Error("Run interrupted");
  return run;
}
