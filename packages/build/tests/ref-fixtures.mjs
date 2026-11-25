import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workspace } from "./plugin-fixtures.mjs";

export async function refFixtures(
  root,
  { depends = 'depends: ["owner"],', table = "items", chain = false } = {},
) {
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
    "api.ts": 'export { add, get, list, remove } from "./rows";',
  });

  const dependent = await plugin("dependent", depends, {
    "schema.ts": `
      import { defineSchema, defineTable, v } from "@tokamak/sdk";
      import * as owner from "plugin:owner/tables";
      export default defineSchema({
        links: defineTable({ item: v.ref(owner.tables.${table}), tag: v.optional(v.string()) })
          .index("by_item", ["item", "tag"]),
      });
    `,
    "rows.ts": dependentRows,
  });

  const leaf = chain
    ? await plugin("leaf", 'depends: ["dependent"],', {
        "schema.ts": `
      import { defineSchema, defineTable, v } from "@tokamak/sdk";
      import { tables } from "plugin:dependent/tables";
      export default defineSchema({ leaves: defineTable({ link: v.optional(v.ref(tables.links)) }) });
    `,
        "rows.ts": `
      import { createFunctions, v } from "@tokamak/sdk";
      import { tables } from "plugin:dependent/tables";
      import schema from "./schema";
      const { query, mutation } = createFunctions(schema);
      export const add = mutation({
        args: { link: v.ref(tables.links) },
        handler: (ctx, { link }) => ctx.db.insert("leaves", { link }),
      });
      export const list = query({ handler: (ctx) => ctx.db.query("leaves").collect() });
    `,
      })
    : undefined;

  return { owner, dependent, leaf };
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
      export const get = query({
        args: { id: v.id("items") },
        handler: (ctx, { id }) => ctx.db.get(id),
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

const dependentRows = `
  import { createFunctions, query as rawQuery, mutation as rawMutation, v,
    type ArgsOf, type Id, type ModelFromSchema, type ResultOf, type TableDocument } from "@tokamak/sdk";
  import { api as owner } from "plugin:owner/server";
  import { tables } from "plugin:owner/tables";
  import schema from "./schema";
  const { query, mutation } = createFunctions(schema);
  export type OwnerLabel = TableDocument<typeof tables.items>["label"];
  type Item = ModelFromSchema<typeof schema>["links"]["item"];
  type Equal<A, B> = [A, B] extends [B, A] ? true : false;
  type Check<Yes extends true> = Yes;
  export type RefId = Check<Equal<Item, Id<"owner.items">>>;
  export type OwnerResult = Check<Equal<ResultOf<typeof owner.add>["item"], Item>>;
  export type OwnerArgument = Check<Equal<ArgsOf<typeof owner.get>["id"], Item>>;
  export const addFromOwner = mutation({
    handler: async (ctx) => {
      const { item } = await ctx.runMutation(owner.add, {});
      const link = await ctx.db.insert("links", { item });
      const row = await ctx.db.get(link);
      return row && (await ctx.runQuery(owner.get, { id: row.item }))?.label;
    },
  });
  // Untyped database builders exercise native enforcement directly.
  export const add = rawMutation({
    args: { id: v.string() },
    handler: (ctx, { id }) => ctx.db.insert("links", { item: id }),
  });
  export const update = rawMutation({
    args: { link: v.id("links"), id: v.string(), replace: v.boolean() },
    handler: (ctx, { link, id, replace }) => replace
      ? ctx.db.replace(link, { item: id })
      : ctx.db.patch(link, { item: id }),
  });
  export const byItem = query({
    args: { id: v.ref(tables.items) },
    handler: (ctx, { id }) => ctx.db.query("links").withIndex("by_item", (q) => q.eq("item", id)).collect(),
  });
  export const foreignRead = rawQuery({
    args: { id: v.id("items") },
    handler: (ctx, { id }) => ctx.db.get(id),
  });
  export const foreignWrite = rawMutation({
    args: { id: v.id("items") },
    handler: (ctx, { id }) => ctx.db.delete(id),
  });
  export const localItems = query({
    // @ts-expect-error Importing a handle does not add an owned table.
    handler: (ctx) => ctx.db.query("items").collect(),
  });
`;
