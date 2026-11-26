import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { existsSync, symlinkSync } from "node:fs";
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
let worker;
let heldOperation;
const host = process.env.TOKAMAK_TEST_PLUGIN_HOST;
assert.ok(host, "The test needs the plugin host");
const withoutBun = process.argv.includes("--without-bun");
const runtimeEnv = { ...process.env };
if (withoutBun) {
  const path = join(scratch, "empty-path");
  await mkdir(path);
  assert.ok(!existsSync(join(path, "bun")));
  runtimeEnv.PATH = path;
  runtimeEnv.HOME = scratch;
}
const logs = [];

const grandchildPidFiles = new Set();
async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await readFile(path, "utf8").catch(() => "");
    if (value) return value;
    await Bun.sleep(20);
  }
  throw new Error(`Program did not create ${path}`);
}

async function expectHeartbeatStopped(path, timeout = 750) {
  let last = await waitForFile(path);
  // The fixture ignores TERM. Leave room for the QuickJS guardian's two-second
  // grace period before requiring the heartbeat to stop.
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    await Bun.sleep(150);
    const current = await readFile(path, "utf8");
    if (current === last) {
      grandchildPidFiles.delete(path + ".pid");
      return;
    }
    last = current;
  }
  assert.fail(`grandchild still running: ${path}`);
}
await mkdir(src, { recursive: true });
acceptance: try {
  symlinkSync(join(import.meta.dir, "../../../app/node_modules"), join(plugin, "node_modules"), "dir");
  await writeFile(join(plugin, "package.json"), '{"name":"local-test","type":"module"}');
  await writeFile(
    join(plugin, "plugin.ts"),
    `
    import { definePlugin } from "@tokamak/sdk";
    export default definePlugin({ id: "local-test", version: "1.0.0" });
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
    import { action, createApi, fail, internalAction, internalQuery, mutation, query, v,
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
    export const runtimeProbe = action({ handler: () => "Bun" in globalThis });
    export const localRuntimeProbe = action({ on: "caller", handler: () => "Bun" in globalThis });
    export const format = internalAction({ handler: () => fail("NoReport", { count: 0 }) });
    export const report = action({ handler: (ctx) => ctx.runAction(internal.turn.format, {}) });
    export const inspect = action({ on: "caller",
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
    export const blocked = action({ on: "caller",
      args: { target: v.string() },
      handler: (ctx, { target }) => target === "format"
        ? ctx.runAction(unchecked.turn.format, {})
        : ctx.runQuery(target === "secret" ? unchecked.turn.secret : unchecked.turn.report, {}),
    });
    let child: RunningProcess | undefined;
    export const run = action({ on: "caller",
      args: { bun: v.string(), file: v.string(), heartbeat: v.string(), hold: v.boolean() },
      handler: async (ctx, { bun, file, heartbeat, hold }) => {
        const source = await readFile(file, "utf8");
        const running = ctx.proc([bun, "-e", source, heartbeat]);
        child = running;
        try {
          for await (const text of running.stdout)
            await ctx.runMutation(api.turn.save, { text: hold ? "hold for cancellation" : text });
          return await running.exited;
        } finally {
          child = undefined;
        }
      },
    });
    export const roundTrip = action({ on: "caller",
      args: { file: v.string(), number: v.number() },
      handler: async (ctx, { file, number }) => {
        const text = await readFile(file, "utf8");
        await ctx.runMutation(api.turn.save, { text });
        const rows = await ctx.runQuery(api.turn.lines, {});
        console.info("local round trip", text);
        return { found: rows.some((row) => row.text === text), number };
      },
    });
    export const slow = action({ on: "caller",
      handler: async (ctx) => {
        console.info("slow call started");
        await new Promise((resolve) => setTimeout(resolve, 200));
        return ctx.runMutation(api.turn.save, { text: "cancelled call wrote a row" });
      },
    });
    export const programIO = action({ on: "caller",
      args: { bun: v.string(), cwd: v.string() },
      handler: async (ctx, { bun, cwd }) => {
        const child = ctx.proc([bun, "-e", \`
          const text = await Bun.stdin.text();
          process.stdout.write("line\\\\n".repeat(4096));
          process.stdout.write(process.cwd() + "\\\\r\\\\n" + text);
          process.stderr.write(process.env.FIXTURE + "\\\\r\\\\n" + JSON.stringify(process.argv.slice(1)));
          process.exitCode = 42;
        \`, "one argument", "$literal"], { cwd, env: { FIXTURE: "stderr" } });
        child.write("stdin ");
        child.write(new Uint8Array([98, 121, 116, 101, 115]));
        child.closeInput();
        const read = async (stream: AsyncIterable<string>) => {
          const lines = [];
          for await (const line of stream) lines.push(line);
          return lines;
        };
        const result = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
        child.write("already exited");
        const [stdout, stderr, code] = result;
        return [stdout.filter((line) => line === "line").length, stdout.slice(-2), stderr, code];
      },
    });
    export const programStartFailure = action({ on: "caller",
      args: { command: v.string(), cwd: v.string() },
      handler: async (ctx, { command, cwd }) => {
        const child = ctx.proc([command], { cwd });
        const read = async (stream: AsyncIterable<string>) => {
          const lines = [];
          for await (const line of stream) lines.push(line);
          return lines;
        };
        return Promise.all([read(child.stdout), read(child.stderr), child.exited]);
      },
    });
    export const callNote = action({ on: "caller",
      args: { id: v.optional(v.id("threads")) },
      handler: (ctx) => ctx.call,
    });
    export const identity = action({ on: "caller", handler: (ctx) => ({ auth: ctx.auth }) });
    export const stop = action({ on: "caller",
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
      stderr: withoutBun ? "pipe" : "inherit",
      env: runtimeEnv,
    },
  );
  const diagnostics = withoutBun ? new Response(server.stderr).text() : undefined;
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
    const processHandle = Bun.spawn([host, join(dist, "local.js")], {
      detached: true,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      cwd: scratch,
      env: runtimeEnv,
    });
    worker = processHandle;
    void (async () => {
      try {
        for await (const line of createInterface({ input: Readable.fromWeb(processHandle.stdout) })) {
          const frame = JSON.parse(line);
          if (frame.type === "log") logs.push(frame.text);
          if (
            frame.type === "op" &&
            frame.name === "plugin.call" &&
            frame.payload.kind === "mutation" &&
            frame.payload.args.text === "hold for cancellation"
          ) {
            heldOperation.resolve();
            continue;
          }
          if (frame.type === "op" && frame.name === "plugin.call") {
            frame.continuation = { depth: 0, thread: null };
          }
          message(frame);
        }
        closed("Plugin host exited");
      } catch (error) {
        closed(String(error));
      }
    })();
    return {
      async route() {
        throw new Error("Unexpected contract route");
      },
      async retire() {},
      async send(value) {
        processHandle.stdin.write(JSON.stringify(value) + "\n");
        processHandle.stdin.flush();
      },
      async close() {
        processHandle.kill();
        processHandle.stdin.end();
        await processHandle.exited;
      },
    };
  });
  const client = new TokamakClient(transport, local);
  const { api } = await import(join(src, "_generated/api.ts"));
  assert.equal(Object.hasOwn(api.turn, "secret"), false);
  assert.equal(Object.hasOwn(api.turn, "format"), false);
  const auth = await client.query(authCaller, {});
  assert.deepEqual(await client.action(api.turn.identity, {}), { auth });
  const threadId = "chat/threads:local-test";
  assert.deepEqual(await client.action(api.turn.callNote, { id: threadId }), { ...auth, threadId, depth: 0 });
  assert.deepEqual(await client.action(api.turn.callNote, {}), { ...auth, depth: 0 });
  assert.deepEqual(await client.action(api.turn.inspect, {}), {
    summary: "private",
    report: { failed: true, kind: "NoReport", data: { count: 0 } },
  });
  assert.equal(await client.action(api.turn.runtimeProbe, {}), false);
  assert.equal(await client.action(api.turn.localRuntimeProbe, {}), false);
  if (withoutBun) {
    server.kill();
    assert.equal(await server.exited, 0);
    assert.doesNotMatch(await diagnostics, /\bBun\b/i);
    console.log("Default QuickJS: caller action and server action passed with an empty PATH.");
    break acceptance;
  }
  for (const target of ["secret", "format"]) {
    assert.deepEqual(await client.action(api.turn.blocked, { target }), {
      failed: true,
      kind: "runnerCapabilityUnavailable",
      data: "privateFunctions",
    });
  }
  await assert.rejects(
    client.action(api.turn.blocked, { target: "report" }),
    /function kind does not match/i,
  );
  const file = join(scratch, "local-input.txt");
  await writeFile(file, "local text");
  const number = 0.018920700000000002;
  assert.deepEqual(await client.action(api.turn.roundTrip, { file, number }), { found: true, number });
  assert.ok(logs.includes("local round trip local text"));

  async function waitForSlowCall() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const index = logs.indexOf("slow call started");
      if (index >= 0) {
        logs.splice(index, 1);
        return;
      }
      await Bun.sleep(10);
    }
    assert.fail("Caller action did not start");
  }

  const abort = new AbortController();
  const slow = client.action(api.turn.slow, {}, { signal: abort.signal });
  void slow.catch(() => {});
  await waitForSlowCall();
  abort.abort();
  await assert.rejects(slow, /cancel|stale invocation: host operation refused/i);
  await Bun.sleep(250);
  assert.deepEqual(
    (await client.query(api.turn.lines, {})).map(({ text }) => text),
    ["local text"],
  );
  console.log(
    `QuickJS: read a file, wrote and queried a live row, received a log, and cancelled a stale write`,
  );

  {
    const interrupted = client.action(api.turn.slow, {});
    void interrupted.catch(() => {});
    await waitForSlowCall();
    worker.kill("SIGKILL");
    await assert.rejects(interrupted, /Plugin host exited/);
    assert.deepEqual(await client.action(api.turn.identity, {}), { auth });
  }

  assert.deepEqual(await client.action(api.turn.programIO, { bun: process.execPath, cwd: scratch }), [
    4096,
    [await realpath(scratch), "stdin bytes"],
    ["stderr", '["one argument","$literal"]'],
    42,
  ]);

  if (process.platform !== "win32") {
    {
      const command = "tokamak-tkm239-missing-command";
      const [stdout, stderr, code] = await client.action(api.turn.programStartFailure, {
        command,
        cwd: scratch,
      });
      assert.deepEqual(stdout, []);
      assert.equal(stderr.length, 1);
      assert.ok(stderr[0].includes(command), stderr);
      assert.equal(code, 127);
    }

    {
      const command = join(scratch, "non-executable");
      await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
      const [stdout, stderr, code] = await client.action(api.turn.programStartFailure, {
        command,
        cwd: scratch,
      });
      assert.deepEqual(stdout, []);
      assert.ok(
        stderr.some((line) => line.includes(command)),
        stderr,
      );
      assert.equal(stderr.length, 1);
      assert.equal(code, 126);
    }

    await assert.rejects(
      client.action(api.turn.programStartFailure, {
        command: "/bin/sh",
        cwd: join(scratch, "missing-cwd"),
      }),
      /Could not use working directory/,
    );
  }

  {
    const rows = Promise.withResolvers();
    stop = client.subscribe(api.turn.lines, {}, (event) => {
      if ("error" in event) rows.reject(event.error);
      else if (event.value.length === 3)
        rows.resolve(event.value.map((row) => row.text).filter((text) => text !== "local text"));
    });
    const start = (label, options, hold = false) => {
      const heartbeat = join(scratch, label + ".heartbeat");
      grandchildPidFiles.add(heartbeat + ".pid");
      const running = client.action(
        api.turn.run,
        { bun: process.execPath, file: fake, heartbeat, hold },
        options,
      );
      void running.catch(() => {});
      return { heartbeat, running };
    };
    const { heartbeat, running } = start("stop");
    const done = Promise.withResolvers();
    void running.then(() => done.reject(new Error("Program exited before the stop call")), done.reject);
    assert.deepEqual(await Promise.race([rows.promise, done.promise]), ["one", "two"]);
    await waitForFile(heartbeat);
    await client.action(api.turn.stop, {});
    await expectHeartbeatStopped(heartbeat);
    assert.notEqual(await running, 0);

    const survivor = start("survivor");
    await waitForFile(survivor.heartbeat);
    const controller = new AbortController();
    heldOperation = Promise.withResolvers();
    const cancelled = start("cancel", { signal: controller.signal }, true);
    await Promise.all([waitForFile(cancelled.heartbeat), heldOperation.promise]);
    const before = await readFile(survivor.heartbeat, "utf8");
    controller.abort();
    await assert.rejects(cancelled.running, /cancel/i);
    await expectHeartbeatStopped(cancelled.heartbeat, 4_000);
    assert.notEqual(await readFile(survivor.heartbeat, "utf8"), before, "other call stopped");
    // This call is still active; close the worker to exercise retirement below.
    // Windows uses the desktop job object rather than the POSIX watchdog.
    if (process.platform !== "win32") {
      await local.close();
      await assert.rejects(survivor.running, /retired/i);
      await expectHeartbeatStopped(survivor.heartbeat, 4_000);
    }
    console.log(
      "read two live rows and verified process-tree cleanup on stop, cancellation, and worker retirement",
    );
  }
  assert.equal((await transport.action("local-test/turn:run", {})).kind, "noMachine");
  await assert.rejects(transport.query("local-test/turn:run", {}), /function kind does not match/i);
  await assert.rejects(transport.mutation("local-test/turn:run", {}), /function kind does not match/i);
  const { revision } = await transport.plugins();
  await assert.rejects(transport.pluginAsset("local-test", "local.js", revision), /asset/i);
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
