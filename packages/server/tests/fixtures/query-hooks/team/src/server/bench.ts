import { createFunctions, v } from "@tokamak/sdk";
import schema from "./schema";

const { query, mutation } = createFunctions(schema);
const read = () => query({ handler: async ({ db }) => (await db.query("users").first())?.name ?? "" });
const save = () =>
  mutation({
    args: { name: v.string() },
    handler: ({ db }, { name }) => db.insert("users", { name }),
  });

export const readPlain = read();
export const readNoop = read();
export const readTable = read();
export const savePlain = save();
export const saveNoop = save();
export const saveTable = save();
