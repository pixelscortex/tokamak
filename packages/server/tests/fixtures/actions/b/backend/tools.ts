import { defineTools, tool, query, mutation, v } from "@tokamak/sdk";

export const { describe, invoke } = defineTools(
  { query, mutation },
  {
    "fixture.create": tool({
      description: "Create a fixture item",
      args: { title: v.string() },
      handler: async ({ db }, { title }) => {
        if (title === "fail") throw new Error("fixture tool failed");
        const id = await db.insert("items", { title });
        return { result: { id }, summary: "Created fixture", model: "Fixture created" };
      },
    }),
  },
);
