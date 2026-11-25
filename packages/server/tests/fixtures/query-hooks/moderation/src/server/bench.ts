import { createHook } from "@tokamak/sdk";
import { readNoop, readTable, saveNoop, saveTable } from "plugin:team/server";
import schema from "./schema";

const hook = createHook(schema);
const before = <T>(_ctx: unknown, args: T) => args;
const after = <T>(_ctx: unknown, result: T) => result;

export const readPassthrough = hook(readNoop, { before, after });
export const savePassthrough = hook(saveNoop, { before, after });

export const readOwnTable = hook(readTable, {
  async before(ctx, args) {
    await ctx.db.query("bans").first();
    return args;
  },
  after,
});

export const saveOwnTable = hook(saveTable, {
  before,
  async after(ctx, result, args) {
    await ctx.db.insert("bans", { name: args.name });
    return result;
  },
});
