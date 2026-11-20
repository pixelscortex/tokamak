import { expect, test } from "bun:test";
import { chmod, cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { withPlugin, workspace } from "../../build/tests/outside-fixture.mjs";
import { cli } from "./cli-fixture.mjs";

test("adds and removes folders and protects an existing id", async () => {
  await withPlugin(async (plugin, root) => {
    const index = join(root, "data", "plugin-index.json");
    const add = (folder) => cli(root, ["plugin", "add", folder, "--json"]);
    for (let i = 0; i < 2; i++) {
      const result = add(plugin);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        id: "outside-fixture",
        restartRequired: true,
      });
    }
    expect(JSON.parse(await readFile(index, "utf8"))).toEqual({ "outside-fixture": plugin });
    const other = join(root, "other");
    await cp(plugin, other, { recursive: true });
    const duplicate = add(other);
    expect(duplicate.code).not.toBe(0);
    expect(JSON.parse(duplicate.stdout).error.next).toBe("tokamak plugin remove outside-fixture");
    const remove = () => cli(root, ["plugin", "remove", "outside-fixture", "--json"]);
    const removed = remove();
    expect(removed.code, removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({
      ok: true,
      id: "outside-fixture",
      restartRequired: true,
    });
    expect(JSON.parse(await readFile(index, "utf8"))).toEqual({});
    expect(remove().code).not.toBe(0);
  });
});

test("tells the user how to start a missing local server", async () => {
  await withPlugin((_, root) => {
    const result = cli(root, ["plugin", "list"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("tokamak server start");
  });
});

test("every registered command shares help and JSON output rules", async () => {
  const { commands } = await import("../src/commands");
  await withPlugin((_, root) => {
    expect(commands.map(({ path }) => path)).toEqual(
      expect.arrayContaining(["plugin build", "plugin add", "plugin remove", "plugin list"]),
    );
    const paths = new Set([""]);
    for (const { path } of commands) {
      const words = path.split(" ");
      for (let n = 1; n <= words.length; n++) paths.add(words.slice(0, n).join(" "));
    }
    for (const path of paths) {
      const words = path ? path.split(" ") : [];
      const shown = cli(root, [...words, "--help"]);
      expect(shown.code, shown.stderr).toBe(0);
      expect(shown.stdout).toContain("Example: tokamak ");
      const success = cli(root, [...words, "--json", "--help"]);
      expect(success.code, success.stderr).toBe(0);
      expect(JSON.parse(success.stdout)).toEqual({ ok: true, help: shown.stdout.trimEnd() });
      expect(success.stderr).toContain("Example: tokamak ");
      const failure = cli(root, [...words, "--json", "--unknown-test-flag"]);
      expect(failure.code).not.toBe(0);
      expect(JSON.parse(failure.stdout)).toEqual({
        ok: false,
        error: { message: expect.stringContaining("Unknown flag"), next: expect.stringContaining("--help") },
      });
    }
    // Flags a command declares must show in its help, and a flag that takes a
    // value must reject a missing one. This covers commands added later.
    for (const command of commands) {
      for (const [name, flag] of Object.entries(command.flags ?? {})) {
        const words = command.path.split(" ");
        expect(cli(root, [...words, "--help"]).stdout).toContain(`--${name}`);
        if (!flag.value) continue;
        const missing = cli(root, [...words, `--${name}`, "--json"]);
        expect(missing.code).not.toBe(0);
        expect(JSON.parse(missing.stdout).error.message).toContain(`after --${name}`);
      }
    }
    for (const command of commands.filter(({ args }) => args && !args.optional)) {
      const missing = cli(root, [...command.path.split(" "), "--json"]);
      expect(missing.code).not.toBe(0);
      expect(JSON.parse(missing.stdout).error.message).toContain("Missing argument");
    }
    const unknown = cli(root, ["unknown-command", "--json"]);
    expect(unknown.code).not.toBe(0);
    expect(JSON.parse(unknown.stdout).error.next).toBe("tokamak --help");
  });
}, 120_000);

async function withServer(root, check, overrides = {}) {
  const data = join(root, "data");
  const plugins = join(root, "installed");
  await mkdir(plugins, { recursive: true });
  await mkdir(data, { recursive: true });
  const token = randomBytes(32).toString("hex");
  const tokenFile = join(data, "server.token");
  await writeFile(tokenFile, token);
  if (process.platform !== "win32") await chmod(tokenFile, 0o600);
  const target = resolve(workspace, process.env.CARGO_TARGET_DIR ?? "target");
  const binary = join(
    target,
    "debug",
    process.platform === "win32" ? "tokamak-server.exe" : "tokamak-server",
  );
  const server = Bun.spawn([binary, "--local-dir", data, "--plugins", plugins], {
    cwd: root,
    env: {
      ...process.env,
      TOKAMAK_WEB_DIR: undefined,
      TOKAMAK_PLUGIN_LOG_DIR: join(root, "logs"),
      ...overrides,
    },
    stdout: "ignore",
    timeout: 110_000,
    stderr: "pipe",
  });
  let address;
  const serverErrors = new Response(server.stderr).text();
  try {
    const deadline = Date.now() + 90_000;
    while (true) {
      const ready = await readFile(join(data, "server.json"), "utf8").catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (ready) {
        address = JSON.parse(ready).url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
        break;
      }
      if (server.exitCode !== null) throw new Error(`Server exited: ${await serverErrors}`);
      if (Date.now() >= deadline) throw new Error("Server did not publish readiness");
      await Bun.sleep(20);
    }
    await check(address, token);
  } finally {
    try {
      if (address) {
        // The server can close the connection before writing the shutdown reply.
        const response = await fetch(`${address}/shutdown`, {
          headers: { Authorization: `Bearer ${token}` },
          method: "POST",
          signal: AbortSignal.timeout(5000),
        }).catch((error) => {
          if (error.code !== "ECONNRESET" && error.code !== "ConnectionClosed") throw error;
        });
        if (response) expect(response.ok).toBe(true);
        expect(await Promise.race([server.exited, Bun.sleep(5000).then(() => null)])).toBe(0);
        expect(await Bun.file(join(data, "server.json")).exists()).toBe(false);
      }
    } finally {
      if (server.exitCode === null) server.kill("SIGKILL");
      await server.exited;
    }
  }
  return await serverErrors;
}

test("a real local server loads and removes an indexed plugin on restart", async () => {
  await withPlugin(async (plugin, root) => {
    function run(args, env) {
      const result = cli(root, ["plugin", ...args, "--json"], env);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    }
    run(["build", plugin]);
    await withServer(root, () => {
      expect(run(["list"])).toEqual({ ok: true, plugins: [] });
      expect(run(["add", plugin]).precedence).toBe("index");
      expect(run(["list"])).toEqual({ ok: true, plugins: [] });
    });
    await withServer(root, (address, token) => {
      const loaded = { ok: true, plugins: [{ id: "outside-fixture", version: "0.1.0", fromIndex: true }] };
      expect(run(["list"])).toEqual(loaded);
      expect(run(["list"], { TOKAMAK_SERVER: address, TOKAMAK_TOKEN: token })).toEqual(loaded);
      expect(
        run(["list", "--server", address], { TOKAMAK_SERVER: "http://127.0.0.1:1", TOKAMAK_TOKEN: token }),
      ).toEqual(loaded);
      run(["remove", "outside-fixture"]);
      expect(run(["list"])).toEqual(loaded);
    });
    await withServer(root, () => {
      expect(run(["list"])).toEqual({ ok: true, plugins: [] });
    });
  });
}, 330_000);

test("rejects empty input and server selection on index commands without leaking credentials", async () => {
  await withPlugin((plugin, root) => {
    const empty = cli(root, ["plugin", "build", "", "--json"]);
    expect(empty.code).not.toBe(0);
    expect(JSON.parse(empty.stdout).error.message).toContain("Empty");
    const address = "http://user:private-password@127.0.0.1:1";
    const add = cli(root, ["plugin", "add", plugin, "--server", address, "--json"]);
    expect(add.code).not.toBe(0);
    expect(JSON.parse(add.stdout).error.message).toContain("--server");
    expect(cli(root, ["plugin", "add", "--help"]).stdout).not.toContain("--server");
    expect(cli(root, ["plugin", "list", "--help"]).stdout).toContain("--server");
    const list = cli(root, ["plugin", "list", "--server", address, "--json"], { TOKAMAK_TOKEN: "test" });
    expect(list.code).not.toBe(0);
    for (const malformed of [`--server=${address}`, address]) {
      const rejected = cli(root, ["plugin", "list", malformed, "--json"]);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stdout + rejected.stderr).not.toContain("private-password");
    }
    expect(list.stdout + list.stderr + add.stdout + add.stderr).not.toContain("private-password");
    expect(Bun.file(join(root, "data", "plugin-index.json")).size).toBe(0);
  });
}, 120_000);

test("closed stdout ends quietly", async () => {
  await withPlugin(async (_, root) => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["packages/cli/src/main.ts", "--help", "--json"], {
      cwd: workspace,
      env: { ...process.env, TOKAMAK_SERVER_DIR: join(root, "data") },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.destroy();
    const [code, signal] = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (...result) => done(result));
    });
    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect(stderr).toBe("");
  });
}, 60_000);

test("concurrent adds preserve every update and recover an abandoned lock", async () => {
  await withPlugin(async (_, root) => {
    const data = join(root, "data");
    const lock = join(data, "plugin-index.json.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "2147483647.abandoned"), "");
    const expected = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`concurrent-${i}`, join(root, `concurrent-${i}`)]),
    );
    await Promise.all(
      Object.entries(expected).map(async ([id, folder]) => {
        await mkdir(folder);
        await writeFile(join(folder, "package.json"), JSON.stringify({ name: id }));
      }),
    );
    await Promise.all(
      Object.values(expected).map(async (folder) => {
        const child = Bun.spawn(
          [process.execPath, "run", "--silent", "tokamak", "plugin", "add", folder, "--json"],
          {
            cwd: workspace,
            env: { ...process.env, TOKAMAK_SERVER_DIR: data },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 60_000,
          },
        );
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, stderr).toBe(0);
        expect(JSON.parse(stdout).ok).toBe(true);
      }),
    );
    expect(JSON.parse(await readFile(join(data, "plugin-index.json"), "utf8"))).toEqual(expected);
    expect(await Bun.file(join(lock, "2147483647.abandoned")).exists()).toBe(false);
  });
}, 120_000);

test("stale discovery sends no token and mismatched health cannot supply a catalog", async () => {
  await withPlugin(async (_, root) => {
    const data = join(root, "data");
    await mkdir(data);
    await writeFile(join(data, "server.token"), "a".repeat(64), { mode: 0o600 });
    const requests = [];
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(new URL(request.url).pathname);
        return Response.json({ plugins: [] });
      },
    });
    const address = `http://127.0.0.1:${listener.port}`;
    const identity = {
      pid: 2147483647,
      url: `ws://127.0.0.1:${listener.port}/ws`,
      bundleHash: "b".repeat(64),
    };
    async function list(env = {}) {
      const child = Bun.spawn([process.execPath, "run", "--silent", "tokamak", "plugin", "list", "--json"], {
        cwd: workspace,
        env: {
          ...process.env,
          TOKAMAK_SERVER: undefined,
          TOKAMAK_TOKEN: undefined,
          TOKAMAK_SERVER_DIR: data,
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      });
      const [code, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).not.toBe(0);
      return JSON.parse(stdout).error;
    }
    try {
      const discovery = join(data, "server.json");
      await writeFile(discovery, JSON.stringify(identity));
      expect((await list()).next).toBe("tokamak server start");
      expect(requests).toEqual([]);
      await writeFile(discovery, JSON.stringify({ ...identity, pid: process.pid }));
      expect((await list()).next).toBe("tokamak server start");
      expect(requests).toEqual(["/health"]);
      expect((await list({ TOKAMAK_SERVER: address })).message).toContain("TOKAMAK_TOKEN");
      expect(requests).toEqual(["/health"]);
    } finally {
      listener.stop(true);
    }
  });
}, 120_000);

test("reads an indexed plugin's log offline and filters errors", async () => {
  await withPlugin(async (plugin, root) => {
    expect(cli(root, ["plugin", "add", plugin]).code).toBe(0);
    const logs = join(root, "logs");
    await mkdir(logs);
    const info = { time: 1000, source: "server", level: "info", text: "ready" };
    const error = { time: 1001, source: "server", level: "error", text: "save: fixture failed" };
    await writeFile(join(logs, "outside-fixture.log"), [info, error].map(JSON.stringify).join("\n") + "\n");
    const run = (...args) => cli(root, ["plugin", "logs", ...args], { TOKAMAK_PLUGIN_LOG_DIR: logs });
    const all = run("outside-fixture");
    expect(all.code, all.stderr).toBe(0);
    expect(all.stdout).toContain("ready");
    const filtered = run("outside-fixture", "--errors", "--json");
    expect(filtered.code, filtered.stderr).toBe(0);
    expect(JSON.parse(filtered.stdout)).toEqual({ ok: true, entries: [error], skipped: 0 });
    const unknown = run("unknown-fixture", "--json");
    expect(unknown.code).not.toBe(0);
    expect(JSON.parse(unknown.stdout).error.message).toContain("Unknown plugin: unknown-fixture");
  });
});

function invoke(address, token, type, name, args = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(address.replace(/^http/, "ws") + "/ws?token=" + token);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Invocation timed out"));
    }, 25_000);
    ws.onopen = () => ws.send(JSON.stringify({ type, id: 1, name, args }));
    ws.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      if (event.id !== 1) return;
      clearTimeout(timeout);
      ws.close();
      resolve(event.result);
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket failed"));
    };
  });
}

test("records worker and embedded plugin output in order and clears only the reloaded plugin", async () => {
  await withPlugin(async (plugin, root) => {
    const worker = join(root, "worker");
    await cp(plugin, worker, { recursive: true });
    await symlink(join(workspace, "node_modules"), join(worker, "node_modules"), "junction");
    const descriptor = join(worker, "plugin.ts");
    await writeFile(
      descriptor,
      (await readFile(descriptor, "utf8"))
        .replace("outside-fixture", "worker-fixture")
        .replace(/id:/, 'runtime: "worker", id:'),
    );
    await writeFile(
      join(worker, "src/server/flood.ts"),
      String.raw`
      import { action, v } from "@tokamak/sdk";
      import { writeSync } from "node:fs";
      export const malformed = action({ handler: () => {
        writeSync(1, '{"type":"log","level":"info","text":"\\ud83d"}\n');
        writeSync(1, '{"type":"log","text":42}\n');
        console.info("x".repeat(20000));
        console.info("x".repeat(8178) + "😀" + "x".repeat(20));
        throw new Error("mapped worker failure");
      } });
      export const producer = action({ args: { mark: v.string() }, handler: async (_, { mark }) => {
        for (let i = 0; i < 120; i++) { console.log(mark + "-" + i); await new Promise<void>((done) => setTimeout(done, 1)); }
        return null;
      } });
      export const ping = action({ handler: () => { console.log("worker ping"); return 42; } });
      export const run = action({ handler: () => {
        for (let i = 0; i < 1000; i++) console.log("burst-" + i + " " + "x".repeat(4500));
        return null;
      } });
    `,
    );
    await writeFile(
      join(plugin, "src/server/failure.ts"),
      `
      import type {} from "@tokamak/sdk/web";
      import { action, mutation, query, v } from "@tokamak/sdk";
      export const wait = action({ handler: async () => {
        console.log("old running action");
        await new Promise<void>((done) => setTimeout(done, 60000));
        return null;
      } });
      export const failing = query({ handler: () => { throw new Error("unchanged subscription error"); } });
      export const validate = query({ args: { text: v.string() }, handler: () => null });
      export const insert = mutation({ handler: async (ctx) => { await ctx.db.insert("notes", { text: "tick" }); return null; } });
      export const read = query({ handler: () => { console.log("embedded query"); return 42; } });
      export const save = mutation({ handler: () => {
        console.log("embedded console");
        throw new Error("fixture mutation failed");
      } });
    `,
    );
    const run = (...args) => {
      const result = cli(root, ["plugin", ...args, "--json"], { TOKAMAK_PLUGIN_LOG_DIR: join(root, "logs") });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    const waitForLog = async (id, ready, ...flags) => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const { entries } = run("logs", id, ...flags);
        if (ready(entries)) return entries;
        if (Date.now() >= deadline) throw new Error(`Plugin log did not catch up: ${id}`);
        await Bun.sleep(25);
      }
    };
    for (const folder of [plugin, worker]) {
      run("build", folder);
      run("add", folder);
    }
    const bad = join(root, "not-a-folder");
    await writeFile(bad, "ordinary file");
    const failedSink = await withServer(
      root,
      async (address, token) => {
        for (let i = 0; i < 2; i++) {
          expect(await invoke(address, token, "query", "outside-fixture/failure:read")).toEqual({ Ok: 42 });
          expect(await invoke(address, token, "action", "worker-fixture/flood:ping")).toEqual({ Ok: 42 });
        }
      },
      { TOKAMAK_PLUGIN_LOG_DIR: bad },
    );
    for (const id of ["outside-fixture", "worker-fixture"]) {
      expect(failedSink.match(new RegExp(`Could not write plugin log ${id}:`, "g"))).toHaveLength(1);
    }
    const serverLog = await withServer(root, async (address, token) => {
      expect((await invoke(address, token, "mutation", "outside-fixture/failure:save")).Err).toContain(
        "fixture mutation failed",
      );
      expect(await waitForLog("outside-fixture", (entries) => entries.length > 0, "--errors")).toEqual([
        expect.objectContaining({
          level: "error",
          source: "server",
          text: expect.stringMatching(/failure:save.*fixture mutation failed/s),
        }),
      ]);
      expect(run("logs", "outside-fixture").entries).toContainEqual(
        expect.objectContaining({ level: "log", text: "embedded console" }),
      );
      expect(await invoke(address, token, "action", "worker-fixture/flood:run")).toEqual({ Ok: null });
      const readBurst = () =>
        run("logs", "worker-fixture").entries.filter(({ text }) => text.startsWith("burst-"));
      const burst = (
        await waitForLog("worker-fixture", (entries) =>
          entries.some(({ text, kind }) => text.startsWith("burst-999 ") || kind === "dropped"),
        )
      ).filter(({ text }) => text.startsWith("burst-"));
      expect(burst).toEqual(
        Array.from({ length: 1000 }, (_, i) => ({
          time: expect.any(Number),
          source: "server",
          level: "log",
          kind: "console",
          text: "burst-" + i + " " + "x".repeat(4500),
        })),
      );
      await Promise.all(
        ["A", "B"].map(async (mark) =>
          expect(await invoke(address, token, "action", "worker-fixture/flood:producer", { mark })).toEqual({
            Ok: null,
          }),
        ),
      );
      const concurrent = (
        await waitForLog("worker-fixture", (entries) =>
          ["A-119", "B-119"].every((end) => entries.some(({ text }) => text === end)),
        )
      ).map(({ text }) => text);
      for (const mark of ["A", "B"]) {
        expect(concurrent.filter((text) => text.startsWith(mark + "-"))).toEqual(
          Array.from({ length: 120 }, (_, i) => mark + "-" + i),
        );
      }
      expect((await invoke(address, token, "action", "worker-fixture/flood:malformed")).Err).toMatch(
        /mapped worker failure[\s\S]*flood\.ts:\d+/,
      );
      expect(await invoke(address, token, "action", "worker-fixture/flood:ping")).toEqual({ Ok: 42 });
      const long = (
        await waitForLog("worker-fixture", (entries) => entries.some(({ text }) => text === "worker ping"))
      ).filter(({ text }) => text.endsWith(" [truncated]"));
      expect(long).toHaveLength(2);
      for (const { text } of long) expect(text).not.toContain("�");
      expect((await invoke(address, token, "query", "outside-fixture/failure:validate")).Err).toContain(
        "required field",
      );
      expect(
        await waitForLog("outside-fixture", (entries) => entries.some(({ kind }) => kind === "validation")),
      ).toContainEqual(expect.objectContaining({ kind: "validation" }));
      const socket = new WebSocket(address.replace(/^http/, "ws") + "/ws?token=" + token);
      try {
        await new Promise((resolve, reject) => {
          socket.onopen = () =>
            socket.send(
              JSON.stringify({ type: "subscribe", id: 1, name: "outside-fixture/failure:failing", args: {} }),
            );
          socket.onmessage = ({ data }) => {
            if (data.includes("unchanged subscription error")) resolve();
          };
          socket.onerror = reject;
        });
        for (let i = 0; i < 3; i++)
          expect(await invoke(address, token, "mutation", "outside-fixture/failure:insert")).toEqual({
            Ok: null,
          });
        expect(
          run("logs", "outside-fixture").entries.filter(({ text }) =>
            text.includes("unchanged subscription error"),
          ),
        ).toHaveLength(1);
      } finally {
        socket.close();
      }
      const catalog = async () =>
        (await fetch(address + "/plugins", { headers: { Authorization: `Bearer ${token}` } })).json();
      const revision = (await catalog()).plugins.find(
        ({ plugin }) => plugin.id === "outside-fixture",
      ).logRevision;
      const report = (id, body, auth = token) =>
        fetch(`${address}/plugins/${id}/window-error?revision=${revision}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${auth}` },
          body,
        });
      expect((await report("outside-fixture", "view failed")).status).toBe(204);
      expect((await report("unknown", "view failed")).status).toBe(404);
      expect((await report("outside-fixture", "view failed", "invalid")).status).toBe(401);
      expect((await report("outside-fixture", "x".repeat(8193))).status).toBe(413);
      for (let i = 0; i < 7; i++) {
        expect((await report("outside-fixture", "repeated window error")).status).toBe(204);
      }
      expect((await report("outside-fixture", "over the window report limit")).status).toBe(429);
      expect((await report("outside-fixture", "still limited")).status).toBe(429);
      expect(
        (
          await waitForLog("outside-fixture", (entries) => entries.some(({ kind }) => kind === "dropped"))
        ).filter(({ kind }) => kind === "dropped"),
      ).toHaveLength(1);
      expect(run("logs", "outside-fixture", "--errors").entries).toContainEqual(
        expect.objectContaining({ source: "window", text: "view failed" }),
      );
      const reload = () =>
        fetch(`${address}/plugins/outside-fixture/reload`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      expect((await reload()).ok).toBe(true);
      expect(run("logs", "outside-fixture").entries).toEqual([]);
      expect(readBurst()).toEqual(burst);
      expect((await report("outside-fixture", "stale view")).status).toBe(409);

      const source = join(plugin, "src/server/failure.ts");
      const original = await readFile(source, "utf8");
      const active = invoke(address, token, "action", "outside-fixture/failure:wait");
      const logFile = join(root, "logs", "outside-fixture.log");
      const deadline = Date.now() + 10_000;
      while (!(await readFile(logFile, "utf8")).includes("old running action")) {
        if (Date.now() > deadline) throw new Error("Old action never started");
        await Bun.sleep(20);
      }
      await writeFile(source, 'console.info("new initializer");\n' + original);
      run("build", plugin);
      expect((await reload()).ok).toBe(true);
      expect((await active).Err).toContain("closed");
      expect(run("logs", "outside-fixture").entries.map(({ text }) => text)).toEqual(["new initializer"]);
      await writeFile(
        source,
        'console.info("rejected initializer"); throw new Error("reject candidate");\n' + original,
      );
      run("build", plugin);
      expect((await reload()).ok).toBe(false);
      expect(run("logs", "outside-fixture").entries.map(({ text }) => text)).toEqual(["new initializer"]);
      expect(readBurst()).toEqual(burst);
    });
    expect(serverLog.match(/dropped malformed log frame/g)).toHaveLength(1);
  });
}, 180_000);

test("reads an unindexed offline log and skips malformed records without losing later entries", async () => {
  await withPlugin(async (_plugin, root) => {
    const logs = join(root, "logs");
    await mkdir(logs);
    const entry = { time: 1, source: "server", level: "error", kind: "exception", text: "kept" };
    const next = { ...entry, time: 2, text: "kept too" };
    await writeFile(
      join(logs, "example.log"),
      `${JSON.stringify(entry)}\n{"torn":\n{}\n${JSON.stringify(next)}\n{"partial":`,
    );
    const read = (...args) => cli(root, ["plugin", "logs", ...args], { TOKAMAK_PLUGIN_LOG_DIR: logs });
    const json = read("example", "--json", "--server", "http://127.0.0.1:1");
    expect(json.code, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ ok: true, entries: [entry, next], skipped: 3 });
    const plain = read("example");
    expect(plain.stdout).toContain("kept too");
    expect(plain.stderr).toContain("Skipped 3 malformed log records.");
    const invalid = read("../example");
    expect(invalid.code).not.toBe(0);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("Unknown plugin");
  });
});

test("two installations sharing an OS temp folder keep independent offline plugin logs", async () => {
  await withPlugin(async (plugin, root) => {
    const temporary = join(root, "temp");
    await mkdir(temporary);
    const env = { TMPDIR: temporary, TEMP: temporary, TMP: temporary, TOKAMAK_PLUGIN_LOG_DIR: undefined };
    await writeFile(
      join(plugin, "src/server/marker.ts"),
      `
      import { query, v } from "@tokamak/sdk";
      export const record = query({ args: { text: v.string() }, handler: (_, { text }) => { console.info(text); return text; } });
    `,
    );
    expect(cli(root, ["plugin", "build", plugin]).code).toBe(0);
    const a = join(root, "a");
    const b = join(root, "b");
    for (const installation of [a, b]) {
      const destination = join(installation, "installed", "fixture", "dist");
      await mkdir(destination, { recursive: true });
      await cp(join(plugin, "dist"), destination, { recursive: true });
    }
    const read = (installation) => {
      const result = cli(installation, ["plugin", "logs", "outside-fixture", "--json"], env);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout).entries.map(({ text }) => text);
    };
    await withServer(
      a,
      async (address, token) => {
        const record = (text) => invoke(address, token, "query", "outside-fixture/marker:record", { text });
        expect(await record("only A")).toEqual({ Ok: "only A" });
        await withServer(
          b,
          async (second, secondToken) => {
            expect(
              await invoke(second, secondToken, "query", "outside-fixture/marker:record", { text: "only B" }),
            ).toEqual({ Ok: "only B" });
            expect(read(a)).toEqual(["only A"]);
            expect(read(b)).toEqual(["only B"]);
            const reload = await fetch(second + "/plugins/outside-fixture/reload", {
              method: "POST",
              headers: { Authorization: `Bearer ${secondToken}` },
            });
            expect(reload.ok).toBe(true);
            expect(read(b)).toEqual([]);
            expect(read(a)).toEqual(["only A"]);
          },
          env,
        );
      },
      env,
    );
    expect(read(a)).toEqual(["only A"]);
    expect(read(b)).toEqual([]);
  });
}, 180_000);
