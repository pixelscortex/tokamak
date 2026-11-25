import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FALLBACK_LOCAL_DEVICE } from "../../sdk/src/index.ts";
import { source, build, built, workspace } from "./plugin-fixtures.mjs";

async function scratch(check) {
  const parent = resolve(workspace, "packages/build/dist");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "boundary-"));
  try {
    await check(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function file(root, path, code) {
  const destination = resolve(root, path);
  await mkdir(resolve(destination, ".."), { recursive: true });
  await writeFile(destination, code);
}
async function backend(root, id) {
  const path = await source(root, id, "", { ui: false });
  await file(
    path,
    "plugin.ts",
    `import { definePlugin } from "@tokamak/sdk"; export default definePlugin({id:${JSON.stringify(id)}, version:"1.0.0", depends:[],});`,
  );
  await file(
    path,
    "src/server/tsconfig.json",
    JSON.stringify({
      extends: resolve(workspace, "tsconfig.json"),
      compilerOptions: { skipLibCheck: true },
    }),
  );
  return path;
}
const output = (path, name) => readFile(resolve(path, "dist", name), "utf8");

test("server rejects runtime and erased imports outside its plugin", async () => {
  await scratch(async (root) => {
    const other = await backend(root, "other");
    await file(
      other,
      "src/server/x.ts",
      'export const value = "foreign implementation"; export type Shape = string;',
    );
    const path = await backend(root, "consumer");
    for (const statement of [
      'import { value } from "../../../other/src/server/x"; export const used = value;',
      'import type { Shape } from "../../../other/src/server/x"; export type Used = Shape;',
      'export * from "../../../other/src/server/x";',
      'export type Used = import("../../../other/src/server/x").Shape;',
      'export const load = () => import("../../../other/src/server/x");',
      'export const load = () => require("../../../other/src/server/x");',
      '/// <reference path="../../../other/src/server/x.ts" />\nexport {};',
    ]) {
      await file(path, "src/server/leak.ts", statement);
      const result = build(path);
      expect(result.status).not.toBe(0);
      const error = result.stdout + result.stderr;
      expect(error).toContain("Plugin import boundary");
      expect(error).toContain("src/server/leak.ts");
      expect(error).toContain("../../../other/src/server/x");
      expect(error).toContain("plugin:<id>/server");
    }
  });
}, 60_000);

test("client rejects relative, absolute, alias and symlink escapes before bundling", async () => {
  await scratch(async (root) => {
    const path = await source(root, "client", "");
    await file(root, "other/src/server/x.ts", 'export const value = "other code";');
    const target = resolve(root, "other/src/server/x.ts");
    await symlink(resolve(root, "other/src"), resolve(path, "src/linked"), "dir");
    await file(
      path,
      "tsconfig.json",
      JSON.stringify({
        extends: resolve(workspace, "app/tsconfig.json"),
        compilerOptions: { paths: { escape: [target] } },
      }),
    );
    for (const id of ["../../other/src/server/x", target, "escape", "./linked/server/x"]) {
      await file(
        path,
        "src/main.tsx",
        `import { value } from ${JSON.stringify(id)}; export const used = value;`,
      );
      const result = build(path);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("Plugin import boundary");
      expect(result.stdout + result.stderr).toContain(id);
      expect(result.stdout + result.stderr).toContain("src/main.tsx");
    }
  });
}, 30_000);

test("server and transaction bundles contain only host references and public types", async () => {
  await scratch(async (root) => {
    const third = await backend(root, "third");
    await file(third, "src/server/api.ts", "export type Label = string;");
    const other = await backend(root, "other");
    await file(
      other,
      "src/server/x.ts",
      `import {query} from "@tokamak/sdk";
        throw new Error("FOREIGN_IMPLEMENTATION_MUST_NOT_RUN");
        export const read = query({handler: () => "FOREIGN_IMPLEMENTATION_MUST_NOT_BUNDLE"});`,
    );
    await file(
      other,
      "src/server/api.ts",
      'import type {Label} from "plugin:third/server"; export {read as readOther} from "./x"; export type Shape<T = Label> = {value:T};',
    );
    const path = await backend(root, "consumer");
    await file(
      path,
      "src/server/main.ts",
      `import {action} from "@tokamak/sdk";
        import {api, readOther, type Shape} from "plugin:other/server";
        import {api as short} from "plugin:other";
        export const call = action({handler: async ctx => {
          const value: Shape = {value: await ctx.use(api).readOther({})};
          await ctx.runQuery(readOther, {});
          return value.value + await ctx.use(short).readOther({});
        }});`,
    );
    // Tests are excluded from the production boundary.
    await file(path, "src/server/main.test.ts", 'import "../../../other/src/server/x";');
    built(path);
    for (const name of ["bundle.js", "bundle.js.map", "transactions.js", "transactions.js.map"]) {
      const bytes = await output(path, name);
      expect(bytes).not.toContain("FOREIGN_IMPLEMENTATION");
      if (name.endsWith(".map")) {
        expect(JSON.parse(bytes).sources.some((source) => source.includes("/other/"))).toBe(false);
      }
    }
    const code = await output(path, "bundle.js");
    expect(code).toContain('createApi("other")');
    expect(code).toContain('["x"]["read"]');
  });
}, 60_000);

test("sanctioned client imports use the registry, including lazy imports", async () => {
  await scratch(async (root) => {
    const owner = await source(root, "owner", 'export { label } from "./client/api";');
    await file(owner, "src/client/api.ts", "export const label = 'owner';");
    built(owner);
    const path = await source(
      root,
      "client",
      `import {label} from "plugin:owner/client";
      export const fromOwner = label;
      export const load = () => import("plugin:owner/client");`,
    );
    built(path);
    const code = await output(path, "ui.js");
    expect(code).toContain("@plugins/owner/ui");
    expect(JSON.parse(await output(path, "manifest.json")).plugin.depends).toEqual({ owner: "*" });
  });
}, 30_000);

test("public aliases preserve registered wire names and calls go through plugin.call", async () => {
  await scratch(async (root) => {
    const other = await source(root, "other", "", { ui: false });
    await file(
      other,
      "src/server/ops.ts",
      `import { query } from "@tokamak/sdk";
      export const read = query({ handler: () => "FOREIGN_RUNTIME" });
      export const hidden = query({ handler: () => "PRIVATE_RUNTIME" });
      export const helper = () => "HELPER_RUNTIME";`,
    );
    await file(
      other,
      "src/server/api.ts",
      `export { read as renamed, helper } from "./ops";
      export type { hidden } from "./ops";`,
    );
    const path = await backend(root, "consumer");
    await file(
      path,
      "src/server/main.ts",
      `import { action } from "@tokamak/sdk";
      import { api, renamed } from "plugin:other/server";
      export const call = action({handler: async ctx => {
        await ctx.use(api).renamed({});
        return ctx.use({renamed}).renamed({});
      }});`,
    );
    built(path);
    const code = await output(path, "bundle.js");
    expect(code).not.toMatch(/FOREIGN_RUNTIME|PRIVATE_RUNTIME|HELPER_RUNTIME/);
    expect(code).not.toContain('references["ops"]["hidden"]');
    const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
    const calls = [];
    const result = await module.invoke(
      { name: "main:call", args: {} },
      {
        op(operation, payload) {
          if (operation === "auth.current")
            return {
              user: { id: "local", name: "You", role: "owner" },
              device: FALLBACK_LOCAL_DEVICE,
            };
          calls.push([operation, payload]);
          return "host result";
        },
      },
    );
    expect(result).toBe("host result");
    expect(calls).toEqual([
      ["plugin.call", { name: "other/ops:read", args: {} }],
      ["plugin.call", { name: "other/ops:read", args: {} }],
    ]);
    await file(
      path,
      "src/server/main.ts",
      `import { helper } from "plugin:other/server"; export const bad = helper();`,
    );
    const failure = build(path);
    expect(failure.status).not.toBe(0);
    expect(failure.stdout + failure.stderr).toContain("helper");
  });
}, 30_000);

test("a linked plugin package cannot bypass the source boundary", async () => {
  await scratch(async (root) => {
    const other = await backend(root, "other");
    await file(other, "src/server/x.ts", 'export const value = "foreign code";');
    await file(
      other,
      "package.json",
      JSON.stringify({ name: "other", type: "module", exports: "./src/server/x.ts" }),
    );
    const path = await source(root, "client", 'import {value} from "other"; export const used = value;');
    await rm(resolve(path, "node_modules"));
    await mkdir(resolve(path, "node_modules"));
    await symlink(
      resolve(workspace, "app/node_modules/@tokamak"),
      resolve(path, "node_modules/@tokamak"),
      "dir",
    );
    await symlink(other, resolve(path, "node_modules/other"), "dir");
    const result = build(path);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Plugin import boundary");
    expect(result.stdout + result.stderr).toContain('imports "other"');
  });
}, 30_000);

test("standalone host mode cannot disable a declared plugin's boundary", async () => {
  await scratch(async (root) => {
    const path = await source(root, "client", 'import "../../outside";', {
      backend: false,
      standalone: true,
    });
    await file(root, "outside.ts", "export const foreign = 1;");
    await file(
      path,
      "plugin.ts",
      'import {definePlugin} from "@tokamak/sdk"; export default definePlugin({id:"client",version:"1.0.0"});',
    );
    await file(path, "src/client/api.ts", 'import "../../../outside";');
    const result = build(path);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Plugin import boundary");
  });
}, 30_000);

test("a symlinked client entry cannot bring in a peer implementation", async () => {
  await scratch(async (root) => {
    const path = await source(root, "client", "");
    await file(root, "outside.tsx", 'export const code = "peer implementation";');
    await rm(resolve(path, "src/main.tsx"));
    await symlink(resolve(root, "outside.tsx"), resolve(path, "src/main.tsx"));
    const result = build(path);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Plugin import boundary");
    expect(result.stdout + result.stderr).toContain("src/main.tsx");
  });
}, 30_000);

test("client rejects erased peer source imports and internal module spelling", async () => {
  await scratch(async (root) => {
    const owner = await source(root, "owner", "");
    await file(owner, "src/client/api.ts", "export type Shape = string;");
    const path = await source(root, "client", "");
    for (const statement of [
      'import type {Shape} from "../../owner/src/client/api"; export type Used = Shape;',
      'export type Used = import("../../owner/src/client/api").Shape;',
      'export const load = () => import("@plugins/owner/ui");',
    ]) {
      await file(path, "src/main.tsx", statement);
      const result = build(path);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("Plugin import boundary");
    }
  });
}, 30_000);

test("query hook stages use the target's types and reject unsupported targets", async () => {
  await scratch(async (root) => {
    const owner = await backend(root, "owner");
    await file(
      owner,
      "src/server/functions.ts",
      `import {query, mutation, v} from "@tokamak/sdk";
       export const read = query({args: {text: v.string()}, handler: (_ctx, {text}) => text.length});
       export const write = mutation({handler: () => null});`,
    );
    await file(owner, "src/server/api.ts", 'export {read, write} from "./functions";');
    const consumer = await backend(root, "consumer");
    const descriptor = resolve(consumer, "plugin.ts");
    await writeFile(
      descriptor,
      (await readFile(descriptor, "utf8")).replace("depends:[]", 'depends:["owner"]'),
    );
    await file(
      consumer,
      "src/server/policy.ts",
      `import {hook, internalQuery} from "@tokamak/sdk";
       import * as owner from "plugin:owner/server";
       import {internal} from "./_generated/internal";
       export const privateRead = internalQuery({handler: () => 1});
       export const badBefore = hook(owner.api.read, {before: (_ctx, args) => ({text: args.text.length})});
       export const badAfter = hook(owner.api.read, {after: (_ctx, result, args) => args.text + result});
       export const badWrite = hook(owner.api.write, {});
       export const badInternal = hook(internal.policy.privateRead, {});`,
    );
    const result = build(consumer);
    expect(result.status).not.toBe(0);
    const diagnostics = result.stdout + result.stderr;
    expect(diagnostics).toContain("Type 'number' is not assignable to type 'string'");
    expect(diagnostics).toContain("Type 'string' is not assignable to type 'MaybePromise<number>'");
    expect(
      diagnostics.match(/hooks on mutations, actions and internal functions are not supported yet/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  });
}, 30_000);
