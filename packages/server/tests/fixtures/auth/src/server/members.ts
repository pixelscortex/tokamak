import { createFunctions, onMember, v } from "@tokamak/sdk";
import * as auth from "plugin:auth/contracts";
import schema from "./schema";

const { query } = createFunctions(schema);

export const added = onMember(auth.memberAdded, async (ctx, user) => {
  await ctx.db.insert("membershipEvents", { member: user.id, event: "added" });
});

export const removed = onMember(auth.memberRemoved, async (ctx, user) => {
  await ctx.db.insert("membershipEvents", { member: user.id, event: "removed" });
});

export const list = query({
  args: { member: v.string() },
  async handler(ctx, { member }) {
    const events = await ctx.db
      .query("membershipEvents")
      .withIndex("by_member", (q) => q.eq("member", member))
      .collect();
    return events.map(({ event }) => event);
  },
});
