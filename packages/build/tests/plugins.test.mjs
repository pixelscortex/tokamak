import { PLUGIN_UI_BUILD_ENABLED } from "../src/vite.ts";
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, cp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const workspace = resolve(import.meta.dir, "../../..");
async function scratch(check) {
  const parent = resolve(workspace, "packages/build/dist");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "plugin-regression-"));
  try {
    await check(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function source(root, id, code, paths = {}) {
  const path = resolve(root, id);
  await mkdir(resolve(path, "src/client"), { recursive: true });
  await writeFile(
    resolve(path, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0", type: "module" }),
  );
  await writeFile(
    resolve(path, "tsconfig.json"),
    JSON.stringify({
      extends: resolve(workspace, "app/tsconfig.json"),
      compilerOptions: { paths },
      include: ["src"],
    }),
  );
  await writeFile(resolve(path, "src/client/api.tsx"), code);
  return path;
}

test("a generated function reference requires callers to handle typed failures", async () => {
  await scratch(async (root) => {
    const path = await source(root, "failures", "export const title = 'Failures';");
    const server = resolve(path, "src/server");
    await mkdir(server);
    await writeFile(
      resolve(server, "ops.ts"),
      `import { fail, query, v } from "@tokamak/sdk";
export const title = query({
  args: { text: v.string() },
  handler: (_, { text }) => text.length > 3 ? fail("TooLong", { max: 3 }) : { title: text },
});
export const text = query({
  args: { text: v.string() },
  handler: (_, { text }) => text.length > 3 ? fail("TooLong", { max: 3 }) : text,
});`,
    );
    const caller = resolve(server, "_caller.ts");
    const imports = `import { isFailure, type ResultOf } from "@tokamak/sdk";
import { api } from "./_generated/api";
type Result = ResultOf<typeof api.ops.title>;`;
    await writeFile(
      caller,
      imports +
        `
export function read(result: Result): string {
  if (result.failed && result.kind === "TooLong") {
    return result.data.max.toFixed();
  }
  return result.failed ? "Unhandled failure" : result.title;
}
export function readText(result: ResultOf<typeof api.ops.text>): string {
  if (isFailure(result)) {
    const kind: "TooLong" = result.kind;
    return kind + result.data.max.toFixed();
  }
  return result.toUpperCase();
}`,
    );
    await writeFile(resolve(server, "compile.ts"), 'export { read, readText } from "./_caller";');
    const build = () =>
      spawnSync(process.execPath, [resolve(workspace, "packages/build/src/build.ts"), path], {
        encoding: "utf8",
      });
    const valid = build();
    expect(valid.status, valid.stdout + valid.stderr).toBe(0);
    await writeFile(
      caller,
      imports +
        "\nexport const read = (result: Result): string => result.title; export const readText = read;",
    );
    const invalid = build();
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout + invalid.stderr).toContain("Property 'title' does not exist");
  });
}, 30_000);

test("internal definitions stay out of the generated public API and window bundle", async () => {
  await scratch(async (root) => {
    const path = await source(
      root,
      "internal-test",
      'import { api } from "../server/_generated/api"; export const visible = api.ops.read;',
    );
    const client = resolve(path, "src/client");
    const server = resolve(path, "src/server");
    await mkdir(server);
    await writeFile(
      resolve(server, "ops.ts"),
      `import { action, internalQuery } from "@tokamak/sdk";
import { internal } from "./_generated/internal";
export const secret = internalQuery({ handler: () => "internal-handler-sentinel" });
export const read = action({ handler: (ctx) => ctx.runQuery(internal.ops.secret, {}) });`,
    );
    const build = () =>
      spawnSync(process.execPath, [resolve(workspace, "packages/build/src/build.ts"), path], {
        encoding: "utf8",
      });
    const result = build();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const publicRefs = resolve(server, "_generated/api.ts");
    const internalRefs = resolve(server, "_generated/internal.ts");
    const { api } = await import(publicRefs);
    expect(api.ops.secret).toBeUndefined();
    const ui = await readFile(resolve(path, "dist/ui.js"), "utf8");
    expect(ui).not.toMatch(/internal-handler-sentinel|ops:secret/);
    const generated = await Promise.all([readFile(publicRefs, "utf8"), readFile(internalRefs, "utf8")]);
    const repeated = build();
    expect(repeated.status, repeated.stdout + repeated.stderr).toBe(0);
    expect(await Promise.all([readFile(publicRefs, "utf8"), readFile(internalRefs, "utf8")])).toEqual(
      generated,
    );

    await writeFile(
      resolve(client, "api.tsx"),
      'import { internal } from "../server/_generated/internal"; export const secret = internal.ops.secret;',
    );
    const leak = build();
    expect(leak.status).not.toBe(0);
    expect(leak.stdout + leak.stderr).toContain("Server code cannot be imported by the window");

    await writeFile(
      resolve(path, "plugin.ts"),
      'export default definePlugin({ id: "internal-test", version: "1.0.0" });\nimport { definePlugin } from "@tokamak/sdk";',
    );
    await writeFile(resolve(server, "api.ts"), 'export { secret as reexported } from "./ops";');
    const reexport = build();
    expect(reexport.status).not.toBe(0);
    expect(reexport.stdout + reexport.stderr).toContain("internal function reexported cannot be exported");
  });
}, 30_000);

test("server artifacts omit UI, verify final hashes and preserve unchanged bytes and mtimes", async () => {
  await scratch(async (root) => {
    await cp(resolve(workspace, "packages/server/tests/fixtures/record"), root, {
      recursive: true,
      filter: (path) => !["dist", "_generated", "node_modules"].includes(path.split("/").at(-1)),
    });
    await writeFile(
      resolve(root, "src/server/tsconfig.json"),
      JSON.stringify({
        extends: resolve(workspace, "tsconfig.json"),
        include: ["**/*.ts"],
        exclude: ["dist"],
      }),
    );
    await mkdir(resolve(root, "src/client"), { recursive: true });
    await writeFile(resolve(root, "src/client/api.tsx"), "this is intentionally invalid UI");
    const build = () => {
      const result = spawnSync(process.execPath, [resolve(workspace, "packages/build/src/build.ts"), root], {
        encoding: "utf8",
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    };
    expect(PLUGIN_UI_BUILD_ENABLED).toBe(true);
    await writeFile(
      resolve(root, "vite.config.ts"),
      `import {tokamak} from "${workspace}/packages/build/src/vite.ts"; export default {plugins:[tokamak({ui:false})]};`,
    );
    build();
    const manifest = JSON.parse(await readFile(resolve(root, "dist/manifest.json"), "utf8"));
    expect(manifest.entries.ui).toBeUndefined();
    expect(manifest.entries.server.code).toBe("bundle.js");
    expect(manifest.publicFunctions).toContain("record:add");
    const before = new Map();
    for (const [name, hash] of Object.entries(manifest.hashes)) {
      const path = resolve(root, "dist", name);
      const bytes = await readFile(path);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
      before.set(name, { bytes, mtime: (await stat(path)).mtimeMs });
    }
    build();
    for (const [name, expected] of before) {
      const path = resolve(root, "dist", name);
      expect(await readFile(path)).toEqual(expected.bytes);
      expect((await stat(path)).mtimeMs).toBe(expected.mtime);
    }
  });
}, 30_000);

test("a plugin using the old server context fails to compile", async () => {
  await scratch(async (root) => {
    const path = await source(root, "old-context", "export const label = 'Old context';");
    await mkdir(resolve(path, "src/server"));
    await writeFile(
      resolve(path, "src/server/ops.ts"),
      `import { query } from "@tokamak/sdk";
export const oldUser = query({ handler: (ctx) => ctx.user });
export const oldProviders = query({ handler: (ctx) => ctx.providers("old.interface") });`,
    );
    const build = spawnSync(process.execPath, [resolve(workspace, "packages/build/src/build.ts"), path], {
      encoding: "utf8",
    });
    expect(build.status, build.stdout + build.stderr).not.toBe(0);
    expect(build.stdout + build.stderr).toContain("Property 'user' does not exist");
    expect(build.stdout + build.stderr).toContain("Property 'providers' does not exist");
  });
}, 30_000);

test("a plugin importing a slot or contribution helper fails to compile", async () => {
  await scratch(async (root) => {
    const path = await source(
      root,
      "old-window",
      `export { defineSlot, fill, itemRenderer, toolbar, command, entityCard, ChatMachineContext } from "@tokamak/sdk/client";`,
    );
    const check = spawnSync(
      process.execPath,
      ["check", "--no-script", "--project", resolve(path, "tsconfig.json")],
      { encoding: "utf8" },
    );
    const diagnostics = check.stdout + check.stderr;
    expect(check.status, diagnostics).not.toBe(0);
    for (const helper of [
      "defineSlot",
      "fill",
      "itemRenderer",
      "toolbar",
      "command",
      "entityCard",
      "ChatMachineContext",
    ])
      expect(diagnostics).toContain(`has no exported member '${helper}'`);
  });
}, 30_000);

test("wrap and replace require named elements and component options cannot declare a page", async () => {
  await scratch(async (root) => {
    const path = await source(
      root,
      "old-component",
      `
import { component, replace, wrap } from "@tokamak/sdk/client";
const Card = component("card", {}, () => <div />);
export const oldPage = component("page", { route: "/" }, () => null);
export const oldWrap = wrap(Card, ({ children }) => children);
export const oldReplace = replace(Card, () => null);
`,
    );
    const check = spawnSync(
      process.execPath,
      ["check", "--no-script", "--project", resolve(path, "tsconfig.json")],
      { encoding: "utf8" },
    );
    const diagnostics = check.stdout + check.stderr;
    expect(check.status, diagnostics).not.toBe(0);
    expect(diagnostics).toMatch(/api\.tsx\(4,\d+\): error/);
    for (const line of [5, 6])
      expect(diagnostics).toMatch(new RegExp(`api\\.tsx\\(${line},\\d+\\): error[^\\n]+UnlockedPart`));
  });
}, 30_000);
