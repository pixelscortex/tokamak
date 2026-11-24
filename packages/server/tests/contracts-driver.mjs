import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createApi, WebSocketTransport } from "../../sdk/src/index.ts";

const target = join(import.meta.dir, "../target");
await mkdir(target, { recursive: true });
const scratch = await mkdtemp(join(target, "contracts-"));
const installs = join(scratch, "installed");
await mkdir(installs);
const owner = "fixture-owner";
const providers = ["fixture-one", "fixture-two"];
const builds = new Map();
let server, socket, transport, desktop;
import { connect, startRunner } from "../../../e2e/fake-agent/harness.mjs";
const cleanup = [];

async function build(id, requirements, files) {
  const root = join(scratch, id);
  const src = join(root, "src");
  await mkdir(src, { recursive: true });
  symlinkSync(join(import.meta.dir, "../../../app/node_modules"), join(root, "node_modules"), "dir");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: id, type: "module" }));
  await writeFile(
    join(root, "plugin.ts"),
    `
    import { definePlugin } from "@tokamak/sdk";
    export default definePlugin({ id: "${id}", version: "1.0.0", ${requirements} });
  `,
  );
  for (const [name, source] of Object.entries(files)) {
    const file = join(src, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, source);
  }
  const result = Bun.spawn([process.execPath, join(import.meta.dir, "../../build/src/build.ts"), root], {
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(await result.exited, 0, `build ${id}`);
  builds.set(id, join(root, "dist"));
}

function provider(id, value) {
  return {
    "provider.ts": `
      import { internalAction, internalQuery, local, query, v } from "@tokamak/sdk";
      import { provide } from "@tokamak/sdk";
      import * as ai from "plugin:${owner}/contracts";
      import { type TurnCtx } from "plugin:${owner}/contracts";

      export const status = query({ handler: () => "${value}" });
      export const localStatus = local({ handler: () => "${value}" });
      const id = "${id}";
      const name = "${value}";
      const info = local({ handler: (ctx) => ctx.auth.user.id });
      export const localProvider = provide(ai.agent, { id, name, info });
      export const hooks = provide(ai.turnHooks, {
        before: local({ handler: async (ctx, t: TurnCtx) => {
          const process = ctx.proc(["git", "--version"], { cwd: t.folder });
          for await (const line of process.stdout) return line.startsWith("git version ");
          return false;
        } }),
      });
      export default provide(ai.service, {
        id: "${id}",
        name: "${value}",
        inspect: internalQuery({ handler: () => "${value}" }),
        call: internalAction({ args: { text: v.string() }, handler: (ctx, { text }) => "${value}:" + text + ":" + ctx.auth.user.id }),
      });
    `,
  };
}

async function checkReloads() {
  await build(owner, "", {
    "contracts.ts": `
      import { contract } from "@tokamak/sdk";
      export type TurnCtx = { folder: string };
      export const agent = contract<{ id: string; name: string; info: () => Promise<string> }>("agent", { place: "local", dataMethods: true });
      export const turnHooks = contract<{ before?: (t: TurnCtx) => Promise<boolean> }>("turnHooks", { place: "local", dataMethods: true });
      export const service = contract<{ id: string; name: string; inspect: () => string; call: (a: { text: string }) => Promise<string> }>("service");
    `,
    "main.ts": `
      import { action, local, query, v } from "@tokamak/sdk";
      import { agent, service, turnHooks } from "./contracts";
      let counter = 0;
      export const localCall = local({
        args: { id: v.string() },
        handler: async (ctx, { id }) => {
          const all = await agent.list(ctx);
          const selected = await agent.get(id, ctx);
          return { ids: all.map((provider) => provider.id), result: (await selected?.info()) ?? null, calls: ++counter };
        },
      });
      export const hooks = local({
        args: { folder: v.string() },
        handler: async (ctx, t) => Promise.all((await turnHooks.list(ctx)).map((p) => p.before?.(t))),
      });
      export const list = query({ handler: async () => {
        const all = await service.list();
        const names = await Promise.all(all.map(async (provider) => [provider.name, await provider.inspect()]));
        return names;
      } });
      export const invoke = action({
        args: { id: v.string() },
        handler: async (ctx, { id }) => (await (await service.get(id, ctx))?.call({ text: "hello" })) ?? null,
      });
      export const withoutContext = action({ handler: () => service.list() });
    `,
  });
  const ownerDeclaration = join(scratch, owner, "src/contracts.ts");
  const declaration = await readFile(ownerDeclaration, "utf8");
  const hidden = join(scratch, "owner-contracts.ts");
  await rename(ownerDeclaration, hidden);
  const copiedDeclaration = `../contracts/${owner}.ts`;
  await build(providers[0], `optional: ["${owner}"]`, {
    ...provider("one", "alpha"),
    [copiedDeclaration]: declaration,
  });
  await build("fixture-stale", `optional: ["${owner}"]`, {
    ...provider("stale", "stale"),
    [copiedDeclaration]: declaration + "\n// stale declaration\n",
  });
  await rename(hidden, ownerDeclaration);
  await build(providers[1], `depends: ["${owner}"]`, provider("two", "beta"));
  await rename(builds.get(providers[0]), join(installs, providers[0]));
  const privateDir = join(scratch, "server");
  await mkdir(privateDir);
  const token = "ab".repeat(32);
  await writeFile(join(privateDir, "server.token"), token, { mode: 0o600 });
  server = Bun.spawn(
    [
      process.argv[2],
      "--plugins",
      installs,
      "--data",
      join(scratch, "db"),
      "--local-dir",
      privateDir,
      "--listen",
      "127.0.0.1:0",
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  let announcement = "";
  while (!announcement.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    announcement += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  const url = announcement.match(/ws:\/\/\S+/)?.[0];
  assert.ok(url, "server announced WebSocket address");
  const headers = { Authorization: `Bearer ${token}` };
  socket = new WebSocket(url, { headers });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  transport = new WebSocketTransport(socket);
  const http = new URL(url);
  http.protocol = "http:";
  async function reload(id) {
    const response = await fetch(new URL(`/plugins/${id}/reload`, http), { method: "POST", headers });
    assert.equal(response.status, 200, await response.text());
  }
  desktop = await startRunner({
    binary: process.argv[3],
    plugins: installs,
    directory: join(scratch, "desktop"),
    env: { TOKAMAK_PLUGIN_HOST: process.env.TOKAMAK_TEST_RUNNER_HOST ?? process.env.TOKAMAK_PLUGIN_HOST },
  });
  const client = await connect(url, { token, launch: desktop.launch, cleanup });
  const api = createApi(owner);
  const first = createApi(providers[0]);
  assert.equal(await client.query(first.provider.status, {}), "alpha");
  assert.equal(await client.local(first.provider.localStatus, {}), "alpha");

  await rename(builds.get(owner), join(installs, owner));
  await reload(owner);
  assert.deepEqual(await client.local(api.main.hooks, { folder: scratch }), [true]);
  assert.deepEqual(await client.query(api.main.list, {}), [["alpha", "alpha"]]);
  assert.equal(await client.action(api.main.invoke, { id: "one" }), "alpha:hello:local");
  await assert.rejects(client.action(api.main.withoutContext, {}), /pass ctx/);
  assert.deepEqual(await client.local(api.main.localCall, { id: "one" }), {
    ids: ["one"],
    result: "local",
    calls: 1,
  });

  await rename(builds.get(providers[1]), join(installs, providers[1]));
  await reload(providers[1]);
  assert.deepEqual(await client.query(api.main.list, {}), [
    ["alpha", "alpha"],
    ["beta", "beta"],
  ]);
  assert.equal(await client.action(api.main.invoke, { id: "two" }), "beta:hello:local");
  assert.deepEqual(await client.local(api.main.localCall, { id: "two" }), {
    ids: ["one", "two"],
    result: "local",
    calls: 2,
  });
  const manifest = JSON.parse(await readFile(join(installs, providers[1], "manifest.json"), "utf8"));
  const method = manifest.contractProviders.find((provider) => provider.name === "service").methods.call;
  const privateMethod = `${providers[1]}/${method}`;
  await assert.rejects(transport.action(privateMethod, { text: "no" }), /unknown function/i);

  await rename(join(installs, providers[1]), builds.get(providers[1]));
  await reload(providers[1]);
  assert.deepEqual(await client.query(api.main.list, {}), [["alpha", "alpha"]]);
  assert.equal(await client.action(api.main.invoke, { id: "two" }), null);
  assert.deepEqual(await client.local(api.main.localCall, { id: "two" }), {
    ids: ["one"],
    result: null,
    calls: 3, // Changing the provider leaves the owner process running.
  });
  await rename(builds.get("fixture-stale"), join(installs, "fixture-stale"));
  const rejected = await fetch(new URL("/plugins/fixture-stale/reload", http), { method: "POST", headers });
  assert.notEqual(rejected.status, 200);
  assert.match(await rejected.text(), /Contract declaration mismatch/);
  assert.deepEqual(await client.query(api.main.list, {}), [["alpha", "alpha"]]);
  console.log("local and server contracts selected providers across install and removal");
}

async function prepareAuth(install) {
  const id = "fixture-sign-in";
  await build(id, 'depends: ["auth"]', {
    "provider.ts": `
      import { internalAction, provide, v } from "@tokamak/sdk";
      import * as auth from "plugin:auth/contracts";
      export default provide(auth.method, {
        id: "basic",
        name: "Basic",
        form: { login: "text", password: "password" },
        signIn: internalAction({
          args: { login: v.string(), password: v.string() },
          handler: async (_ctx, fields) => ({ accountId: fields.login }),
        }),
      });
    `,
  });
  // The Rust test starts the server after this copy and can put its fixture
  // on a different filesystem from the build directory.
  await cp(builds.get(id), join(install, id), { recursive: true });
}

try {
  if (process.argv[2] === "--prepare-auth") await prepareAuth(process.argv[3]);
  else await checkReloads();
} finally {
  for (const close of cleanup.reverse()) await close();
  await desktop?.stop();
  transport?.close();
  socket?.close();
  if (server) {
    server.kill();
    await server.exited;
  }
  await rm(scratch, { recursive: true, force: true });
}
