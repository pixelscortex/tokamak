import { createFunctions, v } from "@tokamak/sdk";
import schema from "./schema";

const { query, mutation } = createFunctions(schema);

export const list = query({
  args: { text: v.string(), mode: v.optional(v.string()), thread: v.optional(v.id("threads")) },
  async handler(ctx, { text, mode }) {
    if (mode === "blocked") throw new Error("TARGET HANDLER RAN");
    return (await ctx.db.query("users").collect())
      .filter((user) => user.name.includes(text))
      .map(({ name }) => ({ name, detail: "" }));
  },
});

export const add = mutation({
  args: { name: v.string() },
  handler: (ctx, { name }) => ctx.db.insert("users", { name }),
});
