import { expect, test } from "bun:test";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, withPlugin, workspace } from "./outside-fixture.mjs";

test("chat publishes its server and window declarations in the artifact", async () => {
  const root = join(workspace, "plugins/chat");
  const result = build(root);
  expect(result.code, result.output).toBe(0);
  const manifest = JSON.parse(await readFile(join(root, "dist/manifest.json"), "utf8"));
  expect(manifest.entries.types).toBe("public.d.ts");
  expect(manifest.hashes["public.d.ts"]).toMatch(/^[a-f0-9]{64}$/);
  const types = await readFile(join(root, "dist", manifest.entries.types), "utf8");
  expect(types).toContain('declare module "plugin:chat/server"');
  expect(types).toContain('declare module "plugin:chat/client"');
}, 90_000);

test("a plugin builds against a sibling containing only the provider artifact", async () => {
  await withPlugin(async (plugin, root) => {
    const entry = join(plugin, "src/client/api.tsx");
    const provider = join(root, "provider-source");
    await mkdir(join(provider, "src/client"), { recursive: true });
    await writeFile(
      join(provider, "plugin.ts"),
      'import { definePlugin } from "@tokamak/sdk"; export default definePlugin({ id: "fixture-api", version: "1.0.0" });',
    );
    await writeFile(join(provider, "src/client/api.ts"), "export const answer = 42;");
    const built = build(provider);
    expect(built.code, built.output).toBe(0);
    await cp(join(provider, "dist"), join(root, "artifact-only", "dist"), { recursive: true });
    await rm(provider, { recursive: true });
    await writeFile(
      entry,
      (await readFile(entry, "utf8")) + '\nexport { answer } from "plugin:fixture-api/client";\n',
    );
    const result = build(plugin);
    expect(result.code, result.output).toBe(0);
    expect(await readFile(join(plugin, ".tokamak/types/fixture-api/public.d.ts"), "utf8")).toContain(
      "answer",
    );
  });
}, 90_000);

test("a missing dependency names the plugin to build or install first", async () => {
  await withPlugin(async (plugin) => {
    const entry = join(plugin, "src/client/api.tsx");
    await writeFile(
      entry,
      (await readFile(entry, "utf8")) + '\nexport { answer } from "plugin:missing-fixture/client";\n',
    );
    const result = build(plugin);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('build or install "missing-fixture" first');
  });
}, 30_000);

test("a public signature cannot expose a type from the plugin's own npm package", async () => {
  await withPlugin(async (plugin, root) => {
    const privatePackage = join(root, "private-package");
    await mkdir(privatePackage);
    await writeFile(
      join(privatePackage, "package.json"),
      JSON.stringify({ name: "private-types", version: "1.0.0", types: "./index.d.ts" }),
    );
    await writeFile(join(privatePackage, "index.d.ts"), "export interface PrivateRecord { value: string }");
    await writeFile(
      join(plugin, "package.json"),
      JSON.stringify({
        name: "outside-fixture",
        dependencies: { "private-types": "file:../private-package" },
      }),
    );
    const entry = join(plugin, "src/client/api.tsx");
    await writeFile(
      entry,
      (await readFile(entry, "utf8")) +
        '\nimport type { PrivateRecord } from "private-types";\nexport function privateValue(): PrivateRecord { return { value: "local" }; }\n',
    );
    const result = build(plugin);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(
      /Cannot publish public types.*PrivateRecord.*non-shared library private-types/,
    );
  });
}, 90_000);

test("Chat's built window and server APIs accept valid calls and reject wrong types", async () => {
  const { default: ts } = await import("typescript");
  const { checkPluginImports, readPluginCompilerOptions } =
    await import("../../sdk/tools/plugin-boundary.mjs");
  await withPlugin(async (plugin, root) => {
    const built = build(join(workspace, "plugins/chat"));
    expect(built.code, built.output).toBe(0);
    await cp(join(workspace, "plugins/chat/dist"), join(root, "published-chat/dist"), { recursive: true });
    const entry = join(plugin, "src/client/contract.ts");
    const valid = `
      import { Composer, composerActions, api as windowApi, type ComposerAPI } from "plugin:chat/client";
      import { api } from "plugin:chat/server";
      import type { ActionContext } from "@tokamak/sdk";
      export function windowContract(props: Parameters<typeof Composer>[0], composer: ComposerAPI) {
        const slotProps: NonNullable<typeof composerActions.props> = { composer };
        return [Composer(props), slotProps, windowApi];
      }
      export async function serverContract(ctx: ActionContext) {
        const rows = await ctx.use(api).listThreads({});
        const title: string = rows[0]!.title;
        return title;
      }
    `;
    await writeFile(entry, valid);
    await checkPluginImports(plugin);
    function diagnostics() {
      const options = readPluginCompilerOptions(plugin, join(plugin, "src/client"), true);
      return ts
        .getPreEmitDiagnostics(ts.createProgram([entry], options))
        .filter((d) => d.file?.fileName === entry)
        .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    }
    const correct = diagnostics();
    expect(correct).toEqual([]);
    await writeFile(
      entry,
      valid.replace("Composer(props)", "Composer(false)").replace("listThreads({})", "listThreads(42)"),
    );
    const wrong = diagnostics();
    expect(wrong).toHaveLength(2);
    expect(wrong.every((message) => message.startsWith("TS2345:"))).toBe(true);
  });
}, 90_000);

test("publication rejects a private ambient npm type in a server result", async () => {
  await withPlugin(async (plugin, root) => {
    await mkdir(join(root, "private"));
    await writeFile(
      join(root, "private/package.json"),
      '{"name":"private-types","version":"1.0.0","types":"index.d.ts"}',
    );
    await writeFile(
      join(root, "private/index.d.ts"),
      "export {}; declare global { interface PrivateRecord { value: string } }",
    );
    await writeFile(
      join(plugin, "package.json"),
      '{"name":"outside-fixture","dependencies":{"private-types":"file:../private"}}',
    );
    await writeFile(
      join(plugin, "src/server/api.ts"),
      `/// <reference types="private-types" />
import { query } from "@tokamak/sdk";
export const read = query({handler(): PrivateRecord { return { value: "typed" }; }});
`,
    );
    const result = build(plugin);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/Cannot publish public types.*PrivateRecord/);
  });
}, 90_000);

test("inferred return types retain the public name for shared component props", async () => {
  await withPlugin(async (plugin) => {
    const entry = join(plugin, "src/client/api.tsx");
    await writeFile(
      entry,
      (await readFile(entry, "utf8")) +
        `
import { Menu } from "@tokamak/ui";
import type { ComponentProps } from "@solidjs/web";
export const menuProps = (props: ComponentProps<typeof Menu.Trigger>) => props;
`,
    );
    const result = build(plugin);
    expect(result.code, result.output).toBe(0);
  });
}, 90_000);

test("a named re-export ignores an unrelated signature that uses a private npm type", async () => {
  await withPlugin(async (plugin, root) => {
    await mkdir(join(root, "private"));
    await writeFile(
      join(root, "private/package.json"),
      '{"name":"private-types","version":"1.0.0","types":"index.d.ts"}',
    );
    await writeFile(join(root, "private/index.d.ts"), "export interface PrivateRecord { value: string }");
    await writeFile(
      join(plugin, "package.json"),
      '{"name":"outside-fixture","dependencies":{"private-types":"file:../private"}}',
    );
    const entry = join(plugin, "src/client/api.tsx");
    await writeFile(entry, (await readFile(entry, "utf8")) + '\nexport { shared } from "./mixed";\n');
    await writeFile(
      join(plugin, "src/client/mixed.ts"),
      `
import type { PrivateRecord } from "private-types";
export const unrelated = (record: PrivateRecord) => record, shared = (value: string) => value;
`,
    );
    const result = build(plugin);
    expect(result.code, result.output).toBe(0);
    const types = await readFile(join(plugin, "dist/public.d.ts"), "utf8");
    expect(types).not.toContain("PrivateRecord");
  });
}, 90_000);

test("ACP checks Chat calls with only Chat's built artifact in a scratch checkout", async () => {
  await withPlugin(async (_, root) => {
    const acp = join(root, "acp");
    const chat = join(root, "published-chat");
    const { code, output } = build(join(workspace, "plugins/chat"));
    expect(code, output).toBe(0);
    await cp(join(workspace, "plugins/chat/dist"), join(chat, "dist"), { recursive: true });
    await cp(join(workspace, "plugins/acp"), acp, {
      recursive: true,
      filter: (path) =>
        !["node_modules", "dist", ".tokamak", "_generated"].includes(path.split(/[/\\\\]/).at(-1)),
    });
    const manifestPath = join(acp, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.devDependencies; // The fixture invokes the checkout's builder directly.
    await writeFile(manifestPath, JSON.stringify(manifest));
    const config = join(acp, "src/server/tsconfig.json");
    const options = JSON.parse(await readFile(config, "utf8"));
    options.compilerOptions.typeRoots = [join(workspace, "node_modules/@types")];
    await writeFile(config, JSON.stringify(options));
    const entry = join(acp, "src/server/contract-probe.ts");
    const valid = `import { api } from "plugin:chat/server";
import type { ActionContext } from "@tokamak/sdk";
export async function check(ctx: ActionContext) {
  const rows = await ctx.use(api).listThreads({});
  const title: string = rows[0]!.title;
  return title;
}
`;
    await writeFile(entry, valid);
    expect(await Bun.file(join(chat, "src/server/api.ts")).exists()).toBe(false);
    const good = build(acp);
    expect(good.code, good.output).toBe(0);
    expect(good.output).toContain("No type errors");
    await writeFile(entry, valid.replace("title: string", "title: number"));
    const bad = build(acp);
    expect(bad.code).not.toBe(0);
    expect(bad.output).toMatch(
      /contract-probe\.ts.*TS2322.*string.*number|contract-probe\.ts.*TS2322[^\n]*>[^\n]*string.*number/s,
    );
    console.info(good.output.split("\n").find((line) => line.includes("No type errors")));
    console.info(
      bad.output.split("\n").find((line) => line.includes("contract-probe.ts") && line.includes("TS2322")),
    );
  });
}, 90_000);
