import { action, v } from "@tokamak/sdk";
import { api } from "./_generated/api";

export const choose = action({
  args: { on: v.optional(v.union(v.literal("caller"), v.literal("server"))) },
  handler: (ctx, { on }) =>
    on === "caller"
      ? ctx.runAction(api.work.serverDefault, {}, { on })
      : ctx.runAction(api.work.callerDefault, {}, { on }),
});

export const program = action({
  args: { file: v.string(), thread: v.id("threads") },
  handler: (ctx, args) => ctx.runAction(api.work.run, args),
});

export const caller = action({
  on: "caller",
  args: { override: v.optional(v.boolean()) },
  handler: (ctx, { override }) =>
    override
      ? ctx.runAction(api.work.serverDefault, {}, { on: "caller" })
      : ctx.runAction(api.work.callerDefault, {}),
});

export const audit = action({
  args: { url: v.string(), text: v.string() },
  handler: (ctx, args) => ctx.runAction(api.work.audited, args),
});
