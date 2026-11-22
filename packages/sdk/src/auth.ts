import { createApi, type FunctionReference } from "./api";
import { internalMutation, type AuthContext, type MutationContext, type User } from "./functions";
import { MEMBER_HOOK_RUN, provide, type Contract, type Provider } from "./internal/contracts";
import { v } from "./validators";
import type { JsonObject } from "./values";

/** The core identity query for the current connection, also available live. */
export const authCaller = createApi<{
  auth: { caller: FunctionReference<"query", Record<string, never>, AuthContext> };
}>().auth.caller;

export type MemberHook = { [MEMBER_HOOK_RUN]: (member: User) => Promise<null> };

const memberHookProviderBrand: unique symbol = Symbol.for("tokamak.auth.memberHook");
type MemberHookProvider = Provider<"server"> & { readonly [memberHookProviderBrand]: true };

export const memberFields = {
  id: v.string(),
  name: v.string(),
  role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
};

/** Register a server mutation triggered by an auth membership change. */
export function onMember(
  event: Contract<MemberHook, "server">,
  handler: (ctx: MutationContext<Record<string, JsonObject>>, member: User) => unknown,
): MemberHookProvider {
  // The build erases this argument in the worker bundle; mutations run in QuickJS.
  const run =
    handler &&
    internalMutation({
      args: memberFields,
      async handler(ctx, member) {
        await handler(ctx, member);
        return null;
      },
    });
  return { ...provide(event, { [MEMBER_HOOK_RUN]: run }), [memberHookProviderBrand]: true };
}
