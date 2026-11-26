import { createFunctions, createTrigger, hook } from "@tokamak/sdk";
import * as team from "plugin:team/server";
import { tables } from "plugin:moderation/tables";
import schema from "./schema";

export const watchBans = createTrigger(schema)(tables.bans, async (ctx, change) => {
  if (change.operation !== "insert") return;

  await ctx.db.insert("events", { name: change.newDoc.name });
  if (change.newDoc.name === "after:trigger-fails") throw new Error("audit trigger failed");
});

export const events = createFunctions(schema).query({
  async handler(ctx) {
    return (await ctx.db.query("events").collect()).map(({ name }) => name).sort();
  },
});

export const chained = hook(team.api.list, {
  before(_ctx, args) {
    return args.mode === "chain" ? { ...args, text: args.text + "l" } : args;
  },
  after(_ctx, users, args) {
    return args.mode === "chain" ? users.map((user) => ({ ...user, detail: user.detail + "|extra" })) : users;
  },
});
