import type {} from "../web";
import { action, httpAction, internalMutation, pluginOnly, query, v } from "../src/index";
import type { ReferenceFromDefinition } from "../src/index";

const queryDef = pluginOnly(query({ args: { key: v.string() }, handler: () => 42 }));
const mutationDef = internalMutation({ args: { text: v.string() }, handler: () => true });
const actionDef = action({ handler: () => "ok" });

declare const queryRef: ReferenceFromDefinition<typeof queryDef>;
declare const mutationRef: ReferenceFromDefinition<typeof mutationDef>;
declare const actionRef: ReferenceFromDefinition<typeof actionDef>;

httpAction({
  path: "/check-types",
  handler: async (ctx, request) => {
    const count: number = await ctx.runQuery(queryRef, { key: "example" });
    const written: boolean = await ctx.runMutation(mutationRef, { text: request.url });
    const result: string = await ctx.runAction(actionRef, {});
    const env: string | null = await ctx.env("KEY");

    // @ts-expect-error A mutation reference cannot be used as a query.
    await ctx.runQuery(mutationRef, { text: "" });
    // @ts-expect-error Argument types come from the referenced function.
    await ctx.runQuery(queryRef, { key: 1 });
    // @ts-expect-error Use a mutation to write; HTTP has no direct database context.
    const database = ctx.db;
    // @ts-expect-error An inbound request does not authenticate a Tokamak member.
    const auth = ctx.auth;
    void [database, auth];

    return Response.json({ count, written, result, env });
  },
});
