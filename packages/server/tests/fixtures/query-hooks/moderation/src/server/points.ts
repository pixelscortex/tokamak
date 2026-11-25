import { createApi, createHook, fail, type PointReference } from "@tokamak/sdk";
import { actPoint, catchPoint, readPoint, savePoint } from "plugin:team/server";
import schema from "./schema";

const hook = createHook(schema);

export const choose = hook(readPoint.points.choose, {
  async before(ctx, { text, mode }) {
    if (mode === "fail") return fail("pointRejected", { reason: "fixture" });
    if (mode === "recursive") await ctx.runQuery(readPoint, { mode });
    if (mode === "wrong") return { text: 2 as unknown as string, mode };
    if (mode === "extra") return { text, mode, extra: true };
    return { text: text + ":hook", mode };
  },
});

export const save = hook(savePoint.points.save, {
  async before(ctx, { name, rollback }) {
    await ctx.db.insert("bans", { name: "point-write" });
    return { name: name + ":before", rollback };
  },
  after(_ctx, result, { name }) {
    if (result !== name) throw new Error("after stage lost transformed input");
    return result + ":after";
  },
});

export const run = hook(actPoint.points.run, {
  before: (ctx, { count }) => ({ count: count + ctx.call.depth + 1 }),
});

const stale = createApi<{
  points: {
    readPoint: {
      points: {
        old: PointReference<"query", string, string, "team", "team/points:readPoint#old", true>;
      };
    };
  };
}>("team", ["points:readPoint"], { "points:readPoint": "query" }, { "points:readPoint": ["old"] });

export const removedPoint = hook(stale.points.readPoint.points.old, {
  before() {
    throw new Error("removed point should have been skipped");
  },
});

export const caught = hook(catchPoint.points.caught, {
  before(_ctx, input) {
    if (Object.hasOwn(input, "note")) throw new Error("undefined field crossed the boundary");
    return input;
  },
  async after(ctx, result) {
    if (result !== null) throw new Error("void result must be null");
    await ctx.db.insert("bans", { name: "caught-point-write" });
    throw new Error("fixture rejected the void point");
  },
});
