import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { symlinkSync } from "node:fs";
import { authCaller, TokamakClient, WebSocketTransport } from "../../sdk/src/index.ts";
import { LocalFunctions } from "../../runtime/js/local.ts";

const target = join(import.meta.dir, "../target");
await mkdir(target, { recursive: true });
const scratch = await mkdtemp(join(target, "local-functions-"));
const plugin = join(scratch, "local-test");
const src = join(plugin, "src");
let server;
let transport;
let local;
let stop;
const grandchildPidFiles = new Set();
async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await readFile(path, "utf8").catch(() => "");
    if (value) return value;
    await Bun.sleep(20);
  }
  throw new Error(`Program did not create ${path}`);
}

async function expectHeartbeatStopped(path) {
  let last = await waitForFile(path);
  for (let attempt = 0; attempt < 5; attempt++) {
    await Bun.sleep(150);
    const current = await readFile(path, "utf8");
    if (current === last) {
      grandchildPidFiles.delete(path + ".pid");
      return;
    }
    last = current;
  }
  assert.fail("grandchild still running");
}
await mkdir(src, { recursive: true });
try {
  symlinkSync(join(import.meta.dir, "../../../app/node_modules"), join(plugin, "node_modules"), "dir");
  await writeFile(join(plugin, "package.json"), '{"name":"local-test","type":"module"}');
  await writeFile(
    join(plugin, "plugin.ts"),
    `
    import { definePlugin } from "@tokamak/sdk";
    export default definePlugin({ id: "local-test", version: "1.0.0", runtime: "worker" });
  `,
  );
  await writeFile(
    join(src, "schema.ts"),
    `
    import { defineSchema, defineTable, v } from "@tokamak/sdk";
    export default defineSchema({ lines: defineTable({ text: v.string() }) });
  `,
  );
  await writeFile(
    join(src, "turn.ts"),
    `
    import { action, createApi, fail, internalAction, internalQuery, local, mutation, query, v,
      type FunctionReference, type RunningProcess } from "@tokamak/sdk";
    import { readFile } from "node:fs/promises";
    import { api } from "./_generated/api";
    import { internal } from "./_generated/internal";
    export const save = mutation({
      args: { text: v.string() },
      handler: ({ db }, { text }) => db.insert("lines", { text }),
    });
    export const lines = query({ handler: ({ db }) => db.query("lines").collect() });
    export const secret = internalQuery({ handler: () => "private" });
    export const summary = query({ handler: (ctx) => ctx.runQuery(internal.turn.secret, {}) });
    export const format = internalAction({ handler: () => fail("NoReport", { count: 0 }) });
    export const report = action({ handler: (ctx) => ctx.runAction(internal.turn.format, {}) });
    export const inspect = local({
      handler: async (ctx) => ({
        summary: await ctx.runQuery(api.turn.summary, {}),
        report: await ctx.runAction(api.turn.report, {}),
      }),
    });
    const unchecked = createApi<{ turn: {
      secret: FunctionReference<"query", {}, string>;
      format: FunctionReference<"action", {}, string>;
      report: FunctionReference<"query", {}, string>;
    } }>("local-test");
    export const blocked = local({
      args: { target: v.string() },
      handler: (ctx, { target }) => target === "format"
        ? ctx.runAction(unchecked.turn.format, {})
        : ctx.runQuery(target === "secret" ? unchecked.turn.secret : unchecked.turn.report, {}),
    });
    let child: RunningProcess | undefined;
    export const run = local({
      args: { bun: v.string(), file: v.string(), heartbeat: v.string() },
      handler: async (ctx, { bun, file, heartbeat }) => {
        const source = await readFile(file, "utf8");
        const running = ctx.proc([bun, "-e", source, heartbeat]);
        child = running;
        try {
          for await (const text of running.stdout) await ctx.runMutation(api.turn.save, { text });
          return await running.exited;
        } finally {
          child = undefined;
        }
      },
    });
    export const identity = local({ handler: (ctx) => ({ auth: ctx.auth }) });
    export const stop = local({
      handler: () => {
        if (!child) throw new Error("No program running");
        child.stop("SIGKILL");
      },
    });
  `,
  );
  const fake = join(scratch, "line-program.js");
  await writeFile(
    fake,
    `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const heartbeat = process.argv[1];
    process.stdout.write("one\\r\\n");
    const grandchild = spawn(process.execPath, ["-e", \`
      const { appendFileSync } = require("node:fs");
      process.on("SIGTERM", () => {});
      process.stdout.write("two\\\\r\\\\n");
      setInterval(() => appendFileSync(process.argv[1], "."), 20);
    \`, heartbeat], { stdio: "inherit" });
    writeFileSync(heartbeat + ".pid", String(grandchild.pid));
    setInterval(() => {}, 60000);
  `,
  );
  const build = Bun.spawn([process.execPath, join(import.meta.dir, "../../build/src/build.ts"), plugin], {
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(await build.exited, 0);
  const dist = join(plugin, "dist");
  server = Bun.spawn(
    [process.argv[2], "--plugins", dist, "--data", join(scratch, "db"), "--listen", "127.0.0.1:0"],
    {
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  let announcement = "";
  while (!announcement.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    announcement += decoder.decode(chunk.value, { stream: true });
  }
  const url = announcement.match(/ws:\/\/\S+/)?.[0];
  assert.ok(url, "real server must announce a WebSocket address");
  reader.releaseLock();
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  transport = new WebSocketTransport(socket);
  local = new LocalFunctions(transport, async (_target, message, closed) => {
    const worker = Bun.spawn([process.execPath, join(dist, "local-entry.js"), join(dist, "local.js")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      cwd: scratch,
      env: { ...process.env, TOKAMAK_WORKER_LANE: "local" },
    });
    void (async () => {
      try {
        for await (const line of createInterface({ input: Readable.fromWeb(worker.stdout) }))
          message(JSON.parse(line));
        closed("Local worker exited");
      } catch (error) {
        closed(String(error));
      }
    })();
    return {
      async send(value) {
        worker.stdin.write(JSON.stringify(value) + "\n");
      },
      async close() {
        worker.kill();
        worker.stdin.end();
        await worker.exited;
      },
    };
  });
  const client = new TokamakClient(transport, local);
  const { api } = await import(join(src, "_generated/api.ts"));
  assert.equal(Object.hasOwn(api.turn, "secret"), false);
  assert.equal(Object.hasOwn(api.turn, "format"), false);
  const auth = await client.query(authCaller, {});
  assert.deepEqual(await client.local(api.turn.identity, {}), { auth });
  assert.deepEqual(await client.local(api.turn.inspect, {}), {
    summary: "private",
    report: { failed: true, kind: "NoReport", data: { count: 0 } },
  });
  await assert.rejects(client.local(api.turn.blocked, { target: "secret" }), /unknown function/i);
  await assert.rejects(client.local(api.turn.blocked, { target: "format" }), /unknown function/i);
  await assert.rejects(client.local(api.turn.blocked, { target: "report" }), /function kind does not match/i);
  const rows = Promise.withResolvers();
  stop = client.subscribe(api.turn.lines, {}, (event) => {
    if ("error" in event) rows.reject(event.error);
    else if (event.value.length === 2) rows.resolve(event.value.map((row) => row.text));
  });
  const start = (label, options) => {
    const heartbeat = join(scratch, label + ".heartbeat");
    grandchildPidFiles.add(heartbeat + ".pid");
    const running = client.local(api.turn.run, { bun: process.execPath, file: fake, heartbeat }, options);
    void running.catch(() => {});
    return { heartbeat, running };
  };
  const { heartbeat, running } = start("stop");
  const done = Promise.withResolvers();
  void running.then(() => done.reject(new Error("Program exited before the stop call")), done.reject);
  assert.deepEqual(await Promise.race([rows.promise, done.promise]), ["one", "two"]);
  await waitForFile(heartbeat);
  await client.local(api.turn.stop, {});
  await expectHeartbeatStopped(heartbeat);
  assert.notEqual(await running, 0);

  const controller = new AbortController();
  const cancelled = start("cancel", { signal: controller.signal });
  await waitForFile(cancelled.heartbeat);
  controller.abort();
  await assert.rejects(cancelled.running, /cancel/i);
  await expectHeartbeatStopped(cancelled.heartbeat);
  await assert.rejects(transport.action("local-test/turn:run", {}), /unknown function/i);
  await assert.rejects(transport.query("local-test/turn:run", {}), /unknown function/i);
  await assert.rejects(transport.mutation("local-test/turn:run", {}), /unknown function/i);
  const { revision } = await transport.plugins();
  await assert.rejects(transport.pluginAsset("local-test", "local.js", revision), /asset/i);
  // The headless launcher can kill Bun outright on POSIX. Production Windows
  // uses the desktop's enclosing job object rather than the POSIX watchdog.
  if (process.platform !== "win32") {
    const retired = start("retire");
    await waitForFile(retired.heartbeat);
    await local.close();
    await assert.rejects(retired.running, /retired/i);
    await expectHeartbeatStopped(retired.heartbeat);
  }
  console.log(
    "read two live rows and verified process-tree cleanup on stop, cancellation, and worker retirement",
  );
} finally {
  for (const pidFile of grandchildPidFiles) {
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  stop?.();
  await local?.close();
  transport?.close();
  server?.kill();
  await server?.exited;
  await rm(scratch, { recursive: true, force: true });
}
