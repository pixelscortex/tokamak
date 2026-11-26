import { createFunctions, point, v, type QueryContext } from "@tokamak/sdk";
import schema from "./schema";

const { query, mutation, action } = createFunctions(schema);

function choose(ctx: Pick<QueryContext<{}>, "call">, mode: string) {
  return point(ctx, "choose", { text: "owner", mode });
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
    return point(ctx, "save", { name: "owner-point", rollback }, async ({ name }) => {
      await ctx.db.insert("users", { name });
      if (rollback) throw new Error("rollback point");
      return name;
    });
  },
});

export const actPoint = action({
  async handler(ctx) {
    const result = await point(ctx, "run", { count: 1 });
    return result.count * 2;
  },
});

export const catchPoint = mutation({
  async handler(ctx) {
    await ctx.db.insert("users", { name: "caught-point" });
    try {
      await point(ctx, "caught", { note: undefined as string | undefined }, async () => {});
    } catch {
      await ctx.db.insert("users", { name: "caught-point-after" });
    }
    return "owner finished";
  },
});
