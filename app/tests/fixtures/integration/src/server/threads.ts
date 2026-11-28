import { createFunctions, v } from "@tokamak/sdk";
import schema from "./schema";

const { query, mutation } = createFunctions(schema);

export const list = query({ handler: ({ db }) => db.query("threads").collect() });

export const start = mutation({
  args: { title: v.string() },
  handler: ({ db }, { title }) => db.insert("threads", { title }),
});
