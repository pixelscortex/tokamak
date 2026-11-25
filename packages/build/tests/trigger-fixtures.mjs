import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { refFixtures, ownerSchema } from "./ref-fixtures.mjs";

export async function triggerFixtures(
  root,
  { depends, table = "items", ownerStages = true, chain = false } = {},
) {
  const { owner, dependent, leaf } = await refFixtures(root, { depends, chain });
  const write = (plugin, file, source) => writeFile(join(plugin, "src", file), source);

  await write(
    owner,
    "schema.ts",
    ownerSchema().replace(
      "folders: defineTable({}),",
      "folders: defineTable({}), selfLoop: defineTable({}), loopA: defineTable({}), loopB: defineTable({}), noop: defineTable({}), write: defineTable({}), cross: defineTable({}),",
    ),
  );
  await write(
    owner,
    "triggers.ts",
    `
    import { createFunctions, createTrigger, v } from "@tokamak/sdk";
    import { api } from "./_generated/api";
    import { internal } from "./_generated/internal";
    import schema from "./schema";
    const trigger = createTrigger(schema);
    const { mutation, internalMutation, query, action } = createFunctions(schema);

    export const addInner = internalMutation({
      args: { label: v.string() },
      handler: (ctx, { label }) => ctx.db.insert("items", { label }),
    });
    export const save = mutation({
      args: { label: v.string(), path: v.string() },
      handler: async (ctx, { label, path }): Promise<string | null> => {
        try {
          if (path === "internal" || path === "nestedCatch") return await ctx.runMutation(internal.triggers.addInner, { label });
          const id = await ctx.db.insert("items", { label });
          if (path === "rollback") throw new Error("owner failed after write");
          return id;
        } catch (error) {
          if (path !== "catch" && path !== "nestedCatch") throw error;
          return null;
        }
      },
    });
    export const saveFromAction = action({
      handler: (ctx): Promise<string | null> => ctx.runMutation(api.triggers.save, { label: "action", path: "direct" }),
    });
    export const bulk = mutation({
      handler: async (ctx) => {
        for (let i = 0; i < 300; i++) await ctx.db.insert("items", { label: "bulk" });
      },
    });
    export const startSelf = mutation({ handler: (ctx) => ctx.db.insert("selfLoop", {}) });
    ${ownerStages ? 'export const selfLoop = trigger("selfLoop", async (ctx) => { await ctx.db.insert("selfLoop", {}); });' : ""}
    export const update = mutation({
      args: { id: v.id("items"), label: v.string(), replace: v.boolean() },
      handler: (ctx, { id, label, replace }) => replace
        ? ctx.db.replace(id, { label })
        : ctx.db.patch(id, { label }),
    });
    export const startLoop = mutation({ handler: (ctx) => ctx.db.insert("loopA", {}) });
    ${
      ownerStages
        ? `export const keepLooping = trigger("loopA", async (ctx, change) => {
      const id: import("@tokamak/sdk").Id<"loopA"> = change.id;
      if (id) await ctx.db.insert("loopB", {});
    });`
        : ""
    }
    export const loops = query({ handler: async (ctx) =>
      (await ctx.db.query("loopA").collect()).length + (await ctx.db.query("loopB").collect()).length,
    });
    export const saveCross = mutation({ handler: (ctx) => ctx.db.insert("cross", {}) });
    export const savePlain = mutation({ handler: (ctx) => ctx.db.insert("folders", {}) });
    export const saveWrite = mutation({ handler: (ctx) => ctx.db.insert("write", {}) });
    ${ownerStages ? 'export const write = trigger("write", async (ctx) => { await ctx.db.insert("others", { label: "audit" }); });' : ""}
    export const saveNoop = mutation({ handler: (ctx) => ctx.db.insert("noop", {}) });
    ${ownerStages ? 'export const noop = trigger("noop", () => {});' : ""}
  `,
  );
  await write(
    owner,
    "api.ts",
    `
    export { add, get, list, remove } from "./rows";
    export { save, startLoop } from "./triggers";
  `,
  );
  await write(
    dependent,
    "schema.ts",
    `
    import { defineSchema, defineTable, v } from "@tokamak/sdk";
    import { tables } from "plugin:owner/tables";
    export default defineSchema({
      links: defineTable({ item: ${depends === undefined && table === "items" ? "v.ref(tables.items)" : "v.string()"} }),
      audit: defineTable({
        table: v.string(), op: v.string(), row: v.string(), before: v.any(), after: v.any(),
        depth: v.number(), user: v.string(),
      }).index("by_row", ["row"]),
    });
  `,
  );
  await write(
    dependent,
    "rows.ts",
    `
    import { createFunctions, createTrigger, v, type Id, type TableDocument } from "@tokamak/sdk";
    import { api as owner } from "plugin:owner/server";
    import { tables } from "plugin:owner/tables";
    import schema from "./schema";
    const trigger = createTrigger(schema);
    const { query, mutation } = createFunctions(schema);
    export const addViaPlugin = mutation({
      args: { label: v.string() },
      handler: (ctx, { label }) => ctx.runMutation(owner.save, { label, path: "direct" }),
    });
    export const link = mutation({
      args: { id: v.string() },
      handler: (ctx, { id }) => ctx.db.insert("links", { item: id as Id<"owner.items"> }),
    });
    export const linkBulk = mutation({
      args: { id: v.string() },
      handler: async (ctx, { id }) => {
        for (let i = 0; i < 300; i++) await ctx.db.insert("links", { item: id as Id<"owner.items"> });
      },
    });
    export const links = query({ handler: (ctx) => ctx.db.query("links").collect() });
    export const events = query({ handler: (ctx) => ctx.db.query("audit").collect() });
    export const track = trigger(tables.${table}, async (ctx, change) => {
      const id: Id<"owner.items"> = change.id;
      const before: TableDocument<typeof tables.items> | null = change.oldDoc;
      const after: TableDocument<typeof tables.items> | null = change.newDoc;
      if (change.operation === "insert") {
        const label: string = change.newDoc.label;
        if (label === "throw") throw new Error("trigger refused the row");
        if (label === "foreign") {
          await ctx.db.delete(id as unknown as Id<"links">);
        }
        if (label === "foreign-patch") await ctx.db.patch(id as unknown as Id<"links">, { item: id });
        if (label === "foreign-insert") await ctx.db.insert("owner.items" as "links", { item: id });
        if (label === "fanout") {
          for (let i = 0; i < 300; i++) await ctx.runQuery(owner.get, { id });
        }
        if ((await ctx.runQuery(owner.get, { id }))?.label !== label)
          throw new Error("trigger cannot see the inserted row");
      }
      await ctx.db.insert("audit", {
        table: "items", op: change.operation, row: id, before, after,
        depth: ctx.call.depth, user: ctx.auth.user.id,
      });
    });
    export const cross = trigger(tables.cross, async (ctx, change) => {
      await ctx.db.insert("audit", {
        table: "cross", op: change.operation, row: change.id, before: change.oldDoc, after: change.newDoc,
        depth: ctx.call.depth, user: ctx.auth.user.id,
      });
    });
    export const observe = trigger(tables.items, () => {});
    export const cascadeTrack = trigger("links", async (ctx, change) => {
      if (change.operation !== "delete") return;
      const audit = await ctx.db.query("audit").withIndex("by_row", (q) => q.eq("row", change.oldDoc.item)).collect();
      if (!audit.some((event) => event.op === "delete" && event.row === change.oldDoc.item))
        throw new Error("the parent delete trigger must run before the cascade");
      await ctx.db.insert("audit", {
        table: "links", op: change.operation, row: change.id, before: change.oldDoc, after: change.newDoc,
        depth: ctx.call.depth, user: ctx.auth.user.id,
      });
    });
    export const loopBack = trigger(tables.loopB, async (ctx) => {
      await ctx.runMutation(owner.startLoop, {});
    });
  `,
  );
  if (leaf) {
    await write(
      leaf,
      "audit.ts",
      `
      import { createTrigger, createFunctions } from "@tokamak/sdk";
      import schema from "./schema";
      const trigger = createTrigger(schema);
      const { query } = createFunctions(schema);
      export const track = trigger("leaves", async (ctx, change) => {
        if (change.operation === "delete") await ctx.db.insert("audit", { row: change.id });
      });
      export const events = query({ handler: (ctx) => ctx.db.query("audit").collect() });
    `,
    );
    await write(
      leaf,
      "schema.ts",
      `
      import { defineSchema, defineTable, v } from "@tokamak/sdk";
      import { tables } from "plugin:dependent/tables";
      export default defineSchema({
        leaves: defineTable({ link: v.optional(v.ref(tables.links)) }),
        audit: defineTable({ row: v.string() }),
      });
    `,
    );
  }
  return { owner, dependent, ...(leaf ? { leaf } : {}) };
}
