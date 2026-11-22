import { createApi, query, v, type FunctionReference } from "@tokamak/sdk";

// Construct the wire reference directly to test server enforcement even when
// code bypasses the generated API, which would never include the internal name.
const other = createApi<{
  ops: Record<"list" | "read", FunctionReference<"query", Record<string, never>, unknown>>;
}>("internal-test", ["ops:list", "ops:read"]);

export const read = query({
  args: { internal: v.boolean() },
  handler: (ctx, args) => ctx.runQuery(args.internal ? other.ops.read : other.ops.list, {}),
});
