import { createFunctions, defineTools, tool, v } from "@tokamak/sdk";
import schema from "./schema";
import { createTodo } from "./createTodo";

const { query, mutation } = createFunctions(schema);

export const { describe, invoke } = defineTools(
  { query, mutation },
  {
    "todos.create": tool({
      description: "Create a task in the user's Todo list.",
      args: { title: v.string() },
      view: "todo.card",
      handler: async ({ db }, { title }) => {
        const id = await createTodo(db, title);
        return {
          result: { id },
          summary: "Created a task in Todo",
          model: `Created task "${title.trim()}" (id ${id}).`,
        };
      },
    }),
  },
);
