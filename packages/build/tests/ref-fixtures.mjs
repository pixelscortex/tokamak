import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workspace } from "./plugin-fixtures.mjs";

export async function refFixtures(root, { depends = 'depends: ["owner"],', table = "items" } = {}) {
  async function plugin(id, requirements, files) {
    const folder = join(root, id);
    await mkdir(join(folder, "src"), { recursive: true });
    await symlink(join(workspace, "app/node_modules"), join(folder, "node_modules"), "dir");
    await writeFile(join(folder, "package.json"), JSON.stringify({ name: id, type: "module" }));
    await writeFile(
      join(folder, "plugin.ts"),
      `
      import { definePlugin } from "@tokamak/sdk";
      export default definePlugin({ id: "${id}", version: "1.0.0", ${requirements} });
    `,
    );
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(folder, "src", name), contents);
    }
    return folder;
  }

  const owner = await plugin("owner", "", {
    "schema.ts": ownerSchema(),
    "rows.ts": ownerRows,
  });

  const dependent = await plugin("dependent", depends, {
    "schema.ts": `
      import { defineSchema, defineTable, v } from "@tokamak/sdk";
      import * as owner from "plugin:owner/tables";
      export default defineSchema({
        links: defineTable({ item: v.ref(owner.tables.${table}) }).index("by_item", ["item"]),
      });
    `,
    "rows.ts": `
      import { createFunctions, v, type Id, type ModelFromSchema, type TableDocument } from "@tokamak/sdk";
      import { tables } from "plugin:owner/tables";
      import schema from "./schema";
      const { query, mutation } = createFunctions(schema);
      export type OwnerLabel = TableDocument<typeof tables.items>["label"];
      type Item = ModelFromSchema<typeof schema>["links"]["item"];
      const typed = (id: Item): Id<"owner.items"> => id;
      const sameType = (id: Id<"owner.items">): Item => id;
      // Pass raw strings to the database to test native write enforcement.
      export const add = mutation({
        args: { id: v.string() },
        handler: (ctx, { id }) => ctx.db.insert("links", { item: sameType(id as Id<"owner.items">) }),
      });
      export const byItem = query({
        args: { id: v.ref(tables.items) },
        handler: (ctx, { id }) => ctx.db.query("links")
          .withIndex("by_item", (q) => q.eq("item", typed(id))).collect(),
      });
      export const foreignRead = query({
        args: { id: v.string() },
        handler: (ctx, { id }) => ctx.db.get(id as Id<"links">),
      });
      export const foreignWrite = mutation({
        args: { id: v.string() },
        handler: (ctx, { id }) => ctx.db.delete(id as Id<"links">),
      });
      export const localItems = query({
        // @ts-expect-error Importing a handle does not add an owned table.
        handler: (ctx) => ctx.db.query("items").collect(),
      });
    `,
  });

  return { owner, dependent };
}

export function ownerSchema(extra = "") {
  return `
    import { defineSchema, defineTable, v } from "@tokamak/sdk";
    export default defineSchema({
      items: defineTable({ label: v.string(), ${extra} }),
      others: defineTable({ label: v.string() }),
    });
  `;
}

const ownerRows = `
      import { createFunctions, fail, v } from "@tokamak/sdk";
      import schema from "./schema";
      const { query, mutation } = createFunctions(schema);
      export const add = mutation({
        handler: async (ctx) => ({
          item: await ctx.db.insert("items", { label: "owner" }),
          other: await ctx.db.insert("others", { label: "other" }),
        }),
      });
      export const list = query({ handler: (ctx) => ctx.db.query("items").collect() });
      export const remove = mutation({
        args: { id: v.id("items"), undo: v.boolean() },
        handler: async (ctx, { id, undo }) => {
          await ctx.db.delete(id);
          if (undo) return fail("undo", null);
          return null;
        },
      });
`;
