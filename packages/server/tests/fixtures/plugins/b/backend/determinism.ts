import { query, v } from "@tokamak/sdk";
import { sample } from "./_sample";
export const snapshot = query({
  args: { burn: v.optional(v.number()) },
  handler: async (ctx, { burn }) => {
    const before = sample();
    await ctx.db.query("items").collect();
    const after = sample();
    // Child-only consumption must not advance its parent's or sibling's stream.
    for (let i = 0; i < (burn ?? 0); i++) Math.random();
    return { before, after };
  },
});
