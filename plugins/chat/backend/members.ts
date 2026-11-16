import { mutation, query } from "./_functions";
import { owner } from "./access";

export const hello = mutation({
  guest: true,
  handler: async ({ db, caller }) => {
    if (caller.role === "guest" && caller.name.toLowerCase() === "owner") throw new Error("Guest name cannot be Owner");
    const member = await db.query("members").withIndex("by_member", q => q.eq("memberId", caller.memberId)).first();
    const value = { memberId: caller.memberId, name: caller.name, lastSeenAt: Date.now() };
    if (member) await db.patch(member._id, value);
    else await db.insert("members", value);

    // The server's caller is the only trusted source of the viewer's role.
    return { memberId: caller.memberId, name: caller.name, role: caller.role };
  },
});

export const list = query({
  handler: ctx => {
    owner(ctx);
    return ctx.db.query("members").collect();
  },
});
