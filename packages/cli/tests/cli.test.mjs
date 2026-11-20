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

async function withServer(root, check) {
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
    env: { ...process.env, TOKAMAK_WEB_DIR: undefined, TOKAMAK_PLUGIN_LOG_DIR: join(root, "logs") },
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
    expect(JSON.parse(filtered.stdout)).toEqual({ ok: true, entries: [error] });
    const unknown = run("unknown-fixture", "--json");
    expect(unknown.code).not.toBe(0);
    expect(JSON.parse(unknown.stdout).error.message).toContain("Unknown plugin: unknown-fixture");
  });
});

function invoke(address, token, type, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(address.replace(/^http/, "ws") + "/ws?token=" + token);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Invocation timed out"));
    }, 25_000);
    ws.onopen = () => ws.send(JSON.stringify({ type, id: 1, name, args: {} }));
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
      `
      import { action } from "@tokamak/sdk";
      export const run = action({ handler: () => {
        for (let i = 0; i < 1000; i++) console.log("burst-" + i + " " + "x".repeat(4500));
        return null;
      } });
    `,
    );
    await writeFile(
      join(plugin, "src/server/failure.ts"),
      `
      import { mutation } from "@tokamak/sdk";
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
    for (const folder of [plugin, worker]) {
      run("build", folder);
      run("add", folder);
    }
    await withServer(root, async (address, token) => {
      expect((await invoke(address, token, "mutation", "outside-fixture/failure:save")).Err).toContain(
        "fixture mutation failed",
      );
      expect(run("logs", "outside-fixture", "--errors").entries).toEqual([
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
      const readBurst = () => run("logs", "worker-fixture").entries.map(({ text }) => text.split(" ")[0]);
      const burst = readBurst();
      expect(burst).toEqual(Array.from({ length: 1000 }, (_, i) => "burst-" + i));
      const report = (id, body, auth = token) =>
        fetch(`${address}/plugins/${id}/window-error`, {
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
      expect(run("logs", "outside-fixture", "--errors").entries).toContainEqual(
        expect.objectContaining({ source: "window", text: "view failed" }),
      );
      const reload = await fetch(`${address}/plugins/outside-fixture/reload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(reload.ok).toBe(true);
      expect(run("logs", "outside-fixture").entries).toEqual([]);
      expect(readBurst()).toEqual(burst);
    });
  });
}, 180_000);
