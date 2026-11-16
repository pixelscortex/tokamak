import {
  createApi,
  mutation,
  query,
  v,
  type ApiFromModule,
  type Id,
  type JsonObject,
  type MutationContext,
  type QueryContext,
} from "@tokamak/sdk";
import { sample } from "./_sample";
const b = createApi<{ determinism: ApiFromModule<typeof import("../../b/backend/determinism")> }>("b");
async function snapshot(
  ctx: QueryContext<Record<string, JsonObject>> | MutationContext<Record<string, JsonObject>>,
  burn = 0,
) {
  const before = sample();
  const first = await ctx.use(b).determinism.snapshot({ burn });
  const second = await ctx.use(b).determinism.snapshot({});
  return { before, first, second, after: sample() };
}
export const read = query({ handler: (ctx) => snapshot(ctx) });
export const write = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id as Id);
    const replay = await snapshot(ctx, Number(row?.value));
    await ctx.db.patch(id as Id, { value: Number(row?.value) + 1, replay });
    await ctx.db.insert("audit", { replay });
    return replay;
  },
});
export const audit = query({ handler: (ctx) => ctx.db.query("audit").collect() });
export const get = query({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.db.get(id as Id) });
