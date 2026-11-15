import { createFunctions, type DatabaseReader, type ModelFromSchema, type Id } from "@tokamak/sdk";
import schema from "./schema";

export const { query, mutation, action } = createFunctions(schema);

// Becomes the host's member id when threads are shared.
export const OWNER = "owner";

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
