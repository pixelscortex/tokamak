import { hook } from "@tokamak/sdk";
import * as team from "plugin:team/server";

export const chained = hook(team.api.list, {
  before(_ctx, args) {
    return args.mode === "chain" ? { ...args, text: args.text + "l" } : args;
  },
  after(_ctx, users, args) {
    return args.mode === "chain" ? users.map((user) => ({ ...user, detail: user.detail + "|extra" })) : users;
  },
});
