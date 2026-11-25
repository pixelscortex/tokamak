import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "bun:test";
import { build, built, source, workspace } from "./plugin-fixtures.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(workspace, "target/contract-build-"));
  try {
    const owner = await source(root, "line-owner", "export function Window() {}", {});
    const provider = await source(root, "line-provider", "export function Window() {}", {});
    await writeFile(join(owner, "plugin.ts"), descriptor("line-owner"));
    await writeFile(join(provider, "plugin.ts"), descriptor("line-provider", 'optional: ["line-owner"],'));
    await writeFile(
      join(owner, "src/contracts.ts"),
      `
      import { contract } from "@tokamak/sdk";
      export const service = contract<{ read: (input: { text: string }) => string }>("service");
      export const line = contract<{ id: string; read: (input: string) => string }>("line", { on: "caller", dataMethods: true });
    `,
    );
    const implementation = join(provider, "src/line.ts");
    await writeFile(implementation, providerSource("basename(input)"));
    await run(owner, provider, implementation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function descriptor(id, extra = "") {
  return `import { definePlugin } from "@tokamak/sdk"; export default definePlugin({ id: "${id}", version: "1.0.0", ${extra} });`;
}

function providerSource(expression) {
  return `
    import { provide } from "@tokamak/sdk";
    import { line } from "plugin:line-owner/contracts";
    import { basename } from "node:path";
    export default provide(line, { id: "path", read: (input) => ${expression} });
  `;
}

await mkdir(join(workspace, "target"), { recursive: true });

test("an optional contract provider builds without a built owner and stays in the local bundle", async () => {
  await fixture(async (owner, provider) => {
    // The contract's public type file is enough to build the optional
    // provider. Neither the dependency's source tree nor build is installed.
    await mkdir(join(provider, "contracts"));
    await rename(join(owner, "src/contracts.ts"), join(provider, "contracts/line-owner.ts"));
    built(provider);
    const dist = join(provider, "dist");
    const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
    assert.equal(manifest.plugin.optional["line-owner"], "*");
    assert.equal(manifest.plugin.depends?.["line-owner"], undefined);
    assert.deepEqual(
      manifest.contractProviders.map(({ owner, name, on }) => ({ owner, name, on })),
      [{ owner: "line-owner", name: "line", on: "caller" }],
    );
    assert.match(await readFile(join(dist, manifest.entries.local.code), "utf8"), /basename/);
    for (const entry of [manifest.entries.ui, manifest.entries.server])
      assert.doesNotMatch(await readFile(join(dist, entry.code), "utf8"), /node:path|basename\(input\)/);
  });
}, 30_000);

test("a provider implementation must match the contract's call shape", async () => {
  await fixture(async (_owner, provider, implementation) => {
    await writeFile(implementation, providerSource("input.length"));
    const result = build(provider);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Type 'number' is not assignable to type 'string'/);
  });
}, 30_000);

test("a provider must declare its contract owner as a dependency", async () => {
  await fixture(async (_owner, provider) => {
    await writeFile(join(provider, "plugin.ts"), descriptor("line-provider"));
    const result = build(provider);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /line-owner.*(depends|optional)/);
  });
}, 30_000);

test("a local contract must declare every method as plain data", async () => {
  await fixture(async (owner, provider) => {
    const path = join(owner, "src/contracts.ts");
    await writeFile(
      path,
      (await readFile(path, "utf8"))
        .replace("read: (input: string) => string", "read: (input: string) => string; live: () => void")
        .replace("dataMethods: true", 'dataMethods: ["read"]'),
    );
    const result = build(provider);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /dataMethods must be true for caller contracts/);
  });
}, 30_000);

function serverProviderSource(read) {
  return `
    import { internalQuery, action, provide, v } from "@tokamak/sdk";
    import * as owner from "plugin:line-owner/contracts";
    const read = ${read};
    export default provide(owner.service, { read });
  `;
}

test("a server provider must match the contract result type", async () => {
  await fixture(async (_owner, provider, implementation) => {
    await writeFile(
      implementation,
      serverProviderSource(
        "internalQuery({ args: { text: v.string() }, handler: (_ctx, { text }) => text.length })",
      ),
    );
    const result = build(provider);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Type 'number' is not assignable to type 'string'/);
  });
}, 30_000);

test("a server provider must declare its contract owner as a dependency", async () => {
  await fixture(async (_owner, provider, implementation) => {
    await writeFile(join(provider, "plugin.ts"), descriptor("line-provider"));
    await writeFile(
      implementation,
      serverProviderSource(
        "internalQuery({ args: { text: v.string() }, handler: (_ctx, { text }) => text })",
      ),
    );
    const result = build(provider);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /line-owner.*(depends|optional)/);
  });
}, 30_000);

test("the plugin build points dependencies on basic-auth to auth", async () => {
  await fixture(async (_owner, provider, implementation) => {
    await writeFile(join(provider, "plugin.ts"), descriptor("line-provider", 'depends: ["basic-auth"],'));
    await writeFile(implementation, "export {};");
    const result = build(provider);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /basic-auth.*depend on auth instead/i);
  });
}, 30_000);

test("the plugin build recognizes an unbuilt sign-in plugin", async () => {
  await fixture(async (owner, consumer, implementation) => {
    await writeSignInProvider(owner, "line-owner");
    await writeFile(implementation, "export {};");
    const result = build(consumer);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /line-owner.*depend on auth instead/i);
  });
}, 30_000);

async function writeSignInProvider(folder, id) {
  await writeFile(join(folder, "plugin.ts"), descriptor(id, 'depends: ["auth"],'));
  await writeFile(
    join(folder, "src/provider.ts"),
    `
    import { internalAction, provide } from "@tokamak/sdk";
    import * as auth from "plugin:auth/contracts";
    const signIn = internalAction({ handler: () => ({ accountId: "test" }) });
    export default provide(auth.method, { id: "custom", name: "Custom", form: {}, signIn });
  `,
  );
}

test("the build rejects an auth provider found by ID in an external artifact catalog", async () => {
  await fixture(async (_owner, consumer, implementation) => {
    const siblings = join(consumer, "..");
    const catalog = join(siblings, "installed");
    const authProvider = await source(catalog, "arbitrary-folder", "export function Window() {}", {});
    await writeSignInProvider(authProvider, "custom-login");
    built(authProvider);
    await writeFile(join(consumer, "plugin.ts"), descriptor("line-provider", 'optional: ["custom-login"],'));
    await writeFile(implementation, "export {};");
    const result = build(consumer, { ...process.env, TOKAMAK_PLUGIN_DIR: catalog });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /custom-login.*depend on auth instead/i);
  });
}, 30_000);
