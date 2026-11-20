import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { readDescriptor, deriveInterfaces, deriveProviders, serverModule } from "../src/descriptor";
import { definePlugin } from "@tokamak/sdk";
import { checkPluginImports } from "../../sdk/tools/plugin-boundary.mjs";
import { build } from "./outside-fixture.mjs";

test("descriptor discovery never executes code and normalizes dependency IDs", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "tokamak-descriptor-"));
  try {
    await writeFile(
      resolve(root, "plugin.ts"),
      `
      import { definePlugin as plugin } from "@tokamak/sdk";
      throw new Error("descriptor was executed");
      export default plugin({id:"example", version:"0.1.0", name:"Example", description:"Example plugin", depends:["chat"], permissions:[]});
    `,
    );
    const descriptor = definePlugin(readDescriptor(root)!);
    expect(descriptor.depends).toEqual({ chat: "*" });
    expect(descriptor.name).toBe("Example");
    for (const expression of [
      "{...metadata}",
      "{id: identifier}",
      '{id:"x", depends: [getId()]}',
      '{id:"x", provides:["chat.backend"]}',
      '{id:"x", breaks:{chat:"*"}}',
    ]) {
      await writeFile(
        resolve(root, "plugin.ts"),
        `import {definePlugin} from "@tokamak/sdk"; export default definePlugin(${expression});`,
      );
      expect(() => readDescriptor(root)).toThrow("static literal metadata");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("topic folders retain callable module IDs and derive literal consumers", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "tokamak-server-layout-"));
  try {
    await mkdir(resolve(root, "src/server/runs"), { recursive: true });
    await writeFile(
      resolve(root, "src/server/runs/send.ts"),
      'throw new Error("do not execute"); async function run(ctx) { return ctx.providers<BackendApi>("chat.backend"); }',
    );
    expect(serverModule(root, "runs/send")).toBe("send");
    expect(deriveInterfaces(root)).toEqual({ consumes: ["chat.backend"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("consumer inference excludes every non-bundled server module", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "tokamak-consumers-"));
  try {
    const server = resolve(root, "src/server");
    for (const file of [
      "api.ts",
      "schema.ts",
      "types.d.ts",
      "example.test.ts",
      "example.spec.ts",
      "tests/example.ts",
      "nested/tests/example.ts",
      "_helpers/example.ts",
      ".hidden/example.ts",
      "node_modules/example/index.ts",
      "dist/example.ts",
      "_private.ts",
      ".hidden.ts",
      "example.tsx",
      "example.js",
    ]) {
      await mkdir(resolve(server, file, ".."), { recursive: true });
      await writeFile(resolve(server, file), 'ctx.providers("excluded.backend");');
    }
    await mkdir(resolve(server, "nested"), { recursive: true });
    await writeFile(resolve(server, "nested/handler.ts"), 'ctx.providers("included.backend");');
    expect(deriveInterfaces(root)).toEqual({ consumes: ["included.backend"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider inference checks public SDK reference kinds, arguments and results", async () => {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "tokamak-providers-"));
  try {
    const provider = resolve(root, "provider");
    const server = resolve(provider, "src/server");
    await mkdir(resolve(root, "contract/src/server"), { recursive: true });
    await mkdir(resolve(server, "_generated"), { recursive: true });
    await writeFile(
      resolve(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "Preserve",
          moduleResolution: "bundler",
          skipLibCheck: true,
          types: [],
        },
      }),
    );
    await writeFile(
      resolve(root, "contract/src/server/api.ts"),
      `
      import type { FunctionReference } from "@tokamak/sdk";
      export type BackendApi = { backend: {
        run: FunctionReference<"action", { text: string }, { value: string }>;
      }};
    `,
    );
    const contract = resolve(root, "contract");
    await writeFile(
      resolve(contract, "plugin.ts"),
      'import { definePlugin } from "@tokamak/sdk"; export default definePlugin({ id: "contract", version: "1.0.0" });',
    );
    const result = build(contract);
    expect(result.code, result.output).toBe(0);
    await rm(resolve(contract, "src"), { recursive: true });
    await checkPluginImports(provider, undefined, ["contract"]);
    await writeFile(
      resolve(server, "_generated/api.ts"),
      `
      import { createApi, type ApiFromModule } from "@tokamak/sdk";
      export const api = createApi<{ backend: ApiFromModule<typeof import("../backend")> }>();
    `,
    );
    const plugin = definePlugin({ id: "provider", version: "0.1.0", depends: { contract: "*" } });
    for (const [definition, expected] of [
      [
        "action({args: {text: v.string()}, handler: (_, args) => ({value: args.text, extra: true})})",
        ["contract.backend"],
      ],
      ['action({args: {text: v.any()}, handler: () => ({value: "ok"})})', ["contract.backend"]],
      ['query({args: {text: v.string()}, handler: () => ({value: "ok"})})', []],
      ['action({args: {text: v.number()}, handler: () => ({value: "ok"})})', []],
      ['action({args: {text: v.string(), required: v.string()}, handler: () => ({value: "ok"})})', []],
      ["action({args: {text: v.string()}, handler: () => ({value: 42})})", []],
      ["action({args: {text: v.string()}, handler: () => ({})})", []],
      ['() => ({value: "ok"})', []],
    ] as const) {
      await writeFile(
        resolve(server, "backend.ts"),
        `
        import { action, query, v } from "@tokamak/sdk";
        throw new Error("provider must not execute");
        const implementation = ${definition};
        export { implementation as run };
      `,
      );
      expect(deriveProviders(provider, plugin, ["backend:run"])).toEqual([...expected]);
    }
    expect(deriveProviders(provider, plugin, [])).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  // This test runs the TypeScript checker over several fixture plugins. On a
  // slow or busy machine that takes longer than the runner's 5 second default,
  // which made it fail by timeout in CI and under load.
}, 60_000);
