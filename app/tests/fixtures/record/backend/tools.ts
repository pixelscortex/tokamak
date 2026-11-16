import { createFunctions, defineTools, tool, v } from "@tokamak/sdk";
import schema from "./schema";
import { createRecord } from "./createRecord";
export const { describe, invoke } = defineTools(createFunctions(schema), {
  "records.create": tool({
    description: "Create a record",
    args: { title: v.string() },
    view: "record.card",
    handler: async ({ db }, { title }) => ({
      result: { id: await createRecord(db, title) },
      summary: "Created a task in Record",
      model: `Created record "${title.trim()}"`,
    }),
  }),
});
