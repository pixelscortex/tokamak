import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, connect, within, workspace } from "../../../e2e/fake-agent/harness.mjs";
import { startRunner } from "../../../e2e/fake-agent/start-runner.ts";
import { authCaller, createApi } from "../../sdk/src/index.ts";

const binary = process.argv[2];
const scratch = await mkdtemp(join(workspace, "target/local-routing-"));
const plugins = join(scratch, "plugins");
const directory = join(scratch, "runner");
const owner = "routed-owner";
const alpha = "routed-alpha";
const beta = "routed-beta";
const crash = "routed-crash";

async function plugin(id, source, contract = "") {
  const root = join(plugins, id);
  await mkdir(join(root, "src/server"), { recursive: true });
  await symlink(join(workspace, "app/node_modules"), join(root, "node_modules"), "dir");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: id, type: "module" }));
  await writeFile(
    join(root, "plugin.ts"),
    `
    import { definePlugin } from "@tokamak/sdk";
    export default definePlugin(${JSON.stringify({
      id,
      version: "1.0.0",
      ...(id !== owner && id !== crash ? { depends: [owner] } : {}),
    })});
  `,
  );
  if (contract) await writeFile(join(root, "src/contracts.ts"), contract);
  await writeFile(join(root, "src/server/probe.ts"), source);
  build(root);
}

await plugin(
  owner,
  `
  import { local, v } from "@tokamak/sdk";
  import { probe } from "../contracts";
  export const identify = local({
    args: { id: v.string() },
    handler: (ctx, { id }) => probe.get(id, ctx).identify(),
  });
  export const hold = local({
    args: { id: v.string(), path: v.string() },
    handler: (ctx, { id, path }) => probe.get(id, ctx).hold(path),
  });
  export const badArgs = local({
    handler: (ctx) => probe.get("${alpha}", ctx).hold((() => {}) as unknown as string),
  });
  export const badResult = local({ handler: (ctx) => probe.get("${alpha}", ctx).badResult() });
`,
  `
  import { contract, type AuthContext } from "@tokamak/sdk";
  export const probe = contract<{
    identify(): Promise<AuthContext>;
    hold(path: string): Promise<string>;
    badResult(): Promise<string>;
  }>("probe", { place: "local", dataMethods: true });
`,
);

function provider(id) {
  return `
    /// <reference types="node" />
    import { readFile, writeFile } from "node:fs/promises";
    import { local, provide } from "@tokamak/sdk";
    import { probe } from "plugin:${owner}/contracts";
    const identify = local({ handler: async (ctx) => ctx.auth });
    const hold = local({
      async handler(ctx, path: string) {
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            void readFile(path + ".release").then(() => { clearInterval(timer); resolve(); }, () => {});
          }, 20);
          ctx.signal.addEventListener("abort", () => {
            clearInterval(timer);
            void writeFile(path + ".cancelled", "cancelled").then(() => resolve());
          }, { once: true });
          void writeFile(path + ".started", "started");
        });
        return "${id}";
      },
    });
    export default provide(probe, {
      identify, hold,
      badResult: async () => (() => {}) as unknown as string,
    });
  `;
}

await plugin(alpha, provider(alpha));
await plugin(beta, provider(beta));
await plugin(
  crash,
  `
  import { local } from "@tokamak/sdk";
  export const ping = local({ handler: () => 1 });
`,
);

async function editBundle(id, extra) {
  const dist = join(plugins, id, "dist");
  const file = join(dist, "local.js");
  const code = (await readFile(file, "utf8")) + "\n" + extra;
  const path = join(dist, "manifest.json");
  const manifest = await Bun.file(path).json();
  manifest.hashes["local.js"] = createHash("sha256").update(code).digest("hex");
  await writeFile(file, code);
  await writeFile(path, JSON.stringify(manifest));
}
await editBundle(crash, 'throw new Error("startup fixture crash");');

const runner = await startRunner({ binary, plugins, directory, env: { TOKAMAK_PLUGIN_RUNTIME: "quickjs" } });
const cleanup = [];
const alive = (pid) => {
  // An orphan reaped by the launcher can briefly be a zombie on Linux.
  const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
    .stdout.toString()
    .trim();
  return state && !state.startsWith("Z");
};
async function until(description, predicate) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  const { ws, token, http } = runner.endpoint;
  const response = await fetch(http + "/health", { headers: { Authorization: "Bearer " + token } });
  const { pid: runnerPid } = await response.json();
  const pids = () => {
    const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]).stdout.toString();
    return Object.fromEntries(
      ps.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+.*tokamak-plugin-host --local-plugin (\S+) /.exec(line);
        return match && Number(match[2]) === runnerPid ? [[match[3], Number(match[1])]] : [];
      }),
    );
  };
  const client = await connect(ws, { token, launch: runner.launch, cleanup });
  const api = createApi(owner).probe;
  const auth = await client.query(authCaller, {});
  assert.deepEqual(await client.local(api.identify, { id: alpha }), auth);
  assert.deepEqual(await client.local(api.identify, { id: beta }), auth);
  const initial = pids();
  assert.deepEqual(Object.keys(initial).sort(), [alpha, beta, owner].sort());
  assert.equal(new Set(Object.values(initial)).size, 3);
  console.log("Three distinct local process PIDs; provider received the signed-in member and device");

  await assert.rejects(client.local(api.badArgs, {}), /routed-owner\/probe\.hold arguments/);
  await assert.rejects(client.local(api.badResult, {}), /routed-owner\/probe\.badResult result/);

  const begin = async (id, name, signal) => {
    const path = join(scratch, name);
    const result = client.local(api.hold, { id, path }, { signal });
    void result.catch(() => {});
    await until(name + " started", () => Bun.file(path + ".started").exists());
    return { path, result };
  };
  const cancel = new AbortController();
  const cancelled = await begin(alpha, "cancel", cancel.signal);
  cancel.abort();
  await assert.rejects(cancelled.result, /cancelled/);
  await until("provider observed cancellation", () => Bun.file(cancelled.path + ".cancelled").exists());
  console.log(
    "Non-plain arguments and results named their method; cancelling the caller aborted the provider",
  );

  const first = await begin(alpha, "kill-alpha");
  const second = await begin(beta, "keep-beta");
  process.kill(initial[alpha], "SIGKILL");
  await assert.rejects(first.result, /Plugin routed-alpha process/);
  await writeFile(second.path + ".release", "");
  assert.equal(await second.result, beta);
  assert.deepEqual(await client.local(api.identify, { id: alpha }), auth);
  const afterCrash = pids();
  assert.notEqual(afterCrash[alpha], initial[alpha]);
  assert.equal(afterCrash[beta], initial[beta]);
  assert.equal(afterCrash[owner], initial[owner]);
  console.log("SIGKILL failed only alpha's in-flight call; beta finished and the next look restarted alpha");

  // Disconnect one window and attach a new one without losing the idle processes.
  for (const close of cleanup.splice(0).reverse()) await close();
  const next = await connect(ws, { token, launch: runner.launch, cleanup });
  assert.deepEqual(await next.local(api.identify, { id: alpha }), auth);
  assert.deepEqual(pids(), afterCrash);

  await editBundle(alpha, "/* replacement local artifact */");
  const control = (await readFile(join(directory, "runner.control"), "utf8")).trim();
  const reload = await fetch(http + "/plugins/" + alpha + "/reload", {
    method: "POST",
    headers: { Authorization: "Bearer " + control },
  });
  assert.equal(reload.status, 200, await reload.text());
  await until("reloaded alpha stopped", () => !alive(afterCrash[alpha]));
  assert.deepEqual(await next.local(api.identify, { id: alpha }), auth);
  const afterReload = pids();
  assert.notEqual(afterReload[alpha], afterCrash[alpha]);
  assert.equal(afterReload[beta], initial[beta]);
  assert.equal(afterReload[owner], initial[owner]);
  console.log("Closing the window kept all three PIDs; reloading alpha replaced only alpha");

  const ping = createApi(crash).probe.ping;
  const delays = [];
  for (const minimum of [0, 225, 475, 975]) {
    const start = performance.now();
    await assert.rejects(next.local(ping, {}), /Plugin routed-crash process/);
    const elapsed = Math.round(performance.now() - start);
    assert.ok(elapsed >= minimum, `startup crash took ${elapsed} ms, expected at least ${minimum}`);
    delays.push(elapsed);
  }
  console.log("Startup crash attempts (ms): " + delays.join(", "));

  assert.equal(await within(runner.stop(), "Runner stop"), 0);
  await until("every host reaped", () => Object.values(afterReload).every((pid) => !alive(pid)));
  console.log("Graceful Runner stop reaped all three local hosts");
} finally {
  for (const close of cleanup.reverse()) await close();
  await runner.stop();
}
