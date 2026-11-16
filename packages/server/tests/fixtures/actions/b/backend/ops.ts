/// <reference lib="dom" />
import { action, mutation, query, v, createApi, type ApiFromModule } from "@tokamak/sdk";
export const publicRead = query({ handler: () => "public" });
export const privateRead = query({ handler: () => "private" });
export const privateWrite = mutation({ handler: (ctx) => ctx.db.insert("private", { value: "denied" }) });
export const deniedFetch = action({
  args: { url: v.string() },
  handler: async (_ctx, { url }) => (await fetch(url)).text(),
});

// Return caught fetch errors so the regressions observe the JavaScript contract.
export const dns = action({
  args: { count: v.number(), host: v.string() },
  handler: async (_ctx, { count, host }) =>
    Promise.all(
      Array.from({ length: count }, async () => {
        try {
          await fetch(`http://${host}/`);
          return { name: "unexpected success", message: "" };
        } catch (error) {
          return { name: (error as Error).name, message: (error as Error).message };
        }
      }),
    ),
});

const todo = createApi<{
  tools: ApiFromModule<typeof import("../../todo/backend/tools")>;
  todo: ApiFromModule<typeof import("../../todo/backend/todo")>;
}>("todo");
export const todoTools = action({
  handler: async (ctx) => {
    const descriptions = await ctx.runQuery(todo.tools.describe, {});
    const out = await ctx.runMutation(todo.tools.invoke, {
      name: "todos.create",
      args: { title: "Buy milk tomorrow" },
      threadId: "test-thread",
    });
    return {
      descriptions,
      out,
      todo: await ctx.runQuery(todo.todo.get, {
        id: (out.result as { id: import("@tokamak/sdk").Id<"todos"> }).id,
      }),
    };
  },
});
