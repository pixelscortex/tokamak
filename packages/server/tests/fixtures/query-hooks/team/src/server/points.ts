import { createFunctions, v, type QueryContext } from "@tokamak/sdk";
import schema from "./schema";

const { query, mutation, action } = createFunctions(schema);

function choose(ctx: Pick<QueryContext<{}>, "point">, mode: string) {
  return ctx.point("choose", { text: "owner", mode });
}

export const readPoint = query({
  args: { mode: v.string() },
  async handler(ctx, { mode }) {
    const value = await choose(ctx, mode);
    if (mode === "fail") throw new Error("owner continued after failed point");
    return value.text;
  },
});

export const savePoint = mutation({
  args: { rollback: v.boolean() },
  async handler(ctx, { rollback }) {
    return ctx.point("save", { name: "owner-point", rollback }, async ({ name }) => {
      await ctx.db.insert("users", { name });
      if (rollback) throw new Error("rollback point");
      return name;
    });
  },
});

export const actPoint = action({
  async handler(ctx) {
    const result = await ctx.point("run", { count: 1 });
    return result.count * 2;
  },
});
