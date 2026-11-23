import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { build, built, source } from "./plugin-fixtures.mjs";

async function fixture(run, worker = false) {
  const root = await mkdtemp(join(tmpdir(), "tokamak-local-build-"));
  try {
    const folder = await source(root, "local-test", 'export { Window } from "./mixed";', {});
    await writeFile(
      join(folder, "plugin.ts"),
      `import { definePlugin } from "@tokamak/sdk"; export default definePlugin({ id: "local-test", version: "1.0.0", ${worker ? 'runtime: "worker"' : ""} });`,
    );
    await run(folder);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("flat mixed source puts each handler in its own artifact", async () => {
  await fixture(async (folder) => {
    await writeFile(
      join(folder, "src/mixed.ts"),
      `
      import { query, createFunctions, defineSchema } from "@tokamak/sdk";
      const { local: onClient } = createFunctions(defineSchema({}));
      import { basename } from "node:path";
      export function Window() { return "window-only-literal"; }
      export const read = query({ handler: () => "server-only-literal" });
      function outputName() { return basename("/local-only-literal"); }
      export const run = onClient({ handler: outputName });
    `,
    );
    built(folder);
    const manifest = JSON.parse(await readFile(join(folder, "dist/manifest.json"), "utf8"));
    for (const [entry, marker] of [
      ["ui", "window"],
      ["server", "server"],
      ["local", "local"],
    ]) {
      const { code, map } = manifest.entries[entry];
      for (const asset of [code, map]) {
        const contents = await readFile(join(folder, "dist", asset), "utf8");
        assert.equal(manifest.hashes[asset], createHash("sha256").update(contents).digest("hex"), asset);
        for (const kind of ["window", "server", "local"]) {
          if (asset === map && kind === marker) continue;
          assert.equal(
            contents.includes(`${kind}-only-literal`),
            asset === code && kind === marker,
            `${kind} literal in ${asset}`,
          );
        }
      }
    }
  });
}, 30_000);

test("local handlers cannot import internal references through a helper", async () => {
  await fixture(async (folder) => {
    await writeFile(
      join(folder, "src/mixed.ts"),
      `
      import { internalQuery, local } from "@tokamak/sdk";
      import { secretRef } from "./helper";
      export function Window() {}
      export const secret = internalQuery({ handler: () => "private" });
      export const run = local({ handler: (ctx) => ctx.runQuery(secretRef, {}) });
      `,
    );
    await writeFile(
      join(folder, "src/helper.ts"),
      'import { internal } from "./_generated/internal"; export const secretRef = internal.mixed.secret;',
    );
    const result = build(folder);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /Local code cannot import internal references/);
  });
}, 30_000);

test("server handlers using ctx.proc get a diagnostic pointing to local", async () => {
  await fixture(async (folder) => {
    await writeFile(
      join(folder, "src/mixed.ts"),
      `
      import { action } from "@tokamak/sdk";
      export function Window() {}
      export const run = action({ handler: (ctx) => ctx.proc(["example"]) });
    `,
    );
    const result = build(folder);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /Property 'proc' does not exist/);
    assert.match(result.stderr + result.stdout, /Move .* into a local function/);
    assert.doesNotMatch(result.stderr + result.stdout, /Call a server function for database access/);
  });
}, 30_000);

test("server handlers cannot import files when a local handler is in the same source", async () => {
  await fixture(async (folder) => {
    await writeFile(
      join(folder, "src/mixed.ts"),
      `
      import { query, local } from "@tokamak/sdk";
      import { readFile } from "node:fs/promises";
      export function Window() {}
      export const read = query({ handler: () => readFile("example", "utf8") });
      export const run = local({ handler: () => readFile("example", "utf8") });
    `,
    );
    const result = build(folder);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /node:fs\/promises.*Move it into a local function/);
  });
}, 30_000);

test("local handlers cannot access a database directly", async () => {
  await fixture(async (folder) => {
    await writeFile(
      join(folder, "src/mixed.ts"),
      `
      import { local } from "@tokamak/sdk";
      export function Window() {}
      export const run = local({ handler: (ctx) => ctx.db.query("items").collect() });
    `,
    );
    const result = build(folder);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /Property 'db' does not exist on type 'LocalContext'/);
    assert.match(result.stderr + result.stdout, /Call a server function for database access/);
    assert.doesNotMatch(result.stderr + result.stdout, /Move .* into a local function/);
  });
}, 30_000);

test("local functions cannot import node:child_process", async () => {
  await fixture(async (folder) => {
    await writeFile(
      join(folder, "src/mixed.ts"),
      `
      import { local } from "@tokamak/sdk";
      import { spawn } from "node:child_process";
      export function Window() {}
      export const run = local({ handler: () => typeof spawn });
      `,
    );
    const result = build(folder);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr + result.stdout,
      /src\/mixed.ts imports "node:child_process".*local functions.*through proc/,
    );
  });
}, 30_000);

test("server actions cannot import node:fs/promises even when a local function can", async () => {
  await fixture(async (folder) => {
    await writeFile(
      join(folder, "src/mixed.ts"),
      `
      import { action, local } from "@tokamak/sdk";
      import { read } from "./helper";
      export function Window() {}
      export const readOnServer = action({ handler: read });
      export const readLocally = local({ handler: read });
      `,
    );
    await writeFile(
      join(folder, "src/helper.ts"),
      'export const read = async () => (await import("fs/promises")).readFile("example", "utf8");',
    );
    const result = build(folder);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr + result.stdout,
      /src\/helper.ts imports "node:fs\/promises".*server actions.*through proc/,
    );
  }, true);
}, 30_000);

test("local functions cannot require a bare built-in through a helper", async () => {
  await fixture(async (folder) => {
    await writeFile(
      join(folder, "src/mixed.ts"),
      `
      import { local } from "@tokamak/sdk";
      import { load } from "./helper";
      export function Window() {}
      export const run = local({ handler: load });
      `,
    );
    await writeFile(
      join(folder, "src/helper.ts"),
      'export const load = () => typeof require("child_process").spawn;',
    );
    const result = build(folder);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr + result.stdout,
      /src\/helper.ts imports "node:child_process".*local functions.*through proc/,
    );
  });
}, 30_000);

test("the server part's Node module check does not apply to the window", async () => {
  await fixture(async (folder) => {
    await writeFile(
      join(folder, "src/main.tsx"),
      'export const Window = () => import("node:child_process");',
    );
    await writeFile(
      join(folder, "src/local.ts"),
      'import { local } from "@tokamak/sdk"; export const run = local({ handler: () => "local" });',
    );
    built(folder);
  });
}, 30_000);
