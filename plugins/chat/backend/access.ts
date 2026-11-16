import type { Caller, DatabaseReader, Id } from "@tokamak/sdk";
import type { Model } from "./_functions";

type Context = { caller: Caller; db: DatabaseReader<Model> };

export function owner(ctx: { caller: Caller }) {
  if (ctx.caller.role !== "owner") throw new Error("Not available to guests");
}

export async function canSee(ctx: Context, threadId: Id<"threads">) {
  if (ctx.caller.role === "owner") return true;
  const shares = await ctx.db
    .query("shares")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  return shares.some((share) => share.memberId === ctx.caller.memberId);
}
