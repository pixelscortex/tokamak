import { expect, test } from "bun:test";
import { chmod, cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { build, withPlugin, workspace } from "../../build/tests/outside-fixture.mjs";
import { cli } from "./cli-fixture.mjs";
import { prepareChatSandbox } from "../../../e2e/chat-sandbox";
import { createApi, TokamakClient, WebSocketTransport } from "../../sdk/src/index";

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

async function withServer(root, check, env = {}) {
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
    env: { ...process.env, TOKAMAK_WEB_DIR: undefined, ...env },
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

test("open reports a missing folder and explains how to start a missing local server", async () => {
  await withPlugin((folder, root) => {
    const invalid = cli(root, ["open", join(root, "missing"), "--json"]);
    expect(invalid.code).not.toBe(0);
    expect(JSON.parse(invalid.stdout).error.message).toContain("Folder does not exist");
    const plain = cli(root, ["open", join(root, "missing")]);
    expect(plain.code).not.toBe(0);
    expect(plain.stdout).toBe("");
    expect(plain.stderr).toContain("Folder does not exist");
    expect(invalid.stderr).toContain("Folder does not exist");
    const offline = cli(root, ["open", folder, "--json"]);
    expect(offline.code).not.toBe(0);
    expect(JSON.parse(offline.stdout).error.next).toBe("tokamak server start");
  });
});

test("open remembers the folder on a real local server without an agent or window", async () => {
  await withPlugin(async (folder, root) => {
    const chat = join(workspace, "plugins/chat");
    const built = build(chat);
    expect(built.code, built.output).toBe(0);
    await mkdir(join(root, "installed"), { recursive: true });
    await cp(join(chat, "dist"), join(root, "installed", "chat"), { recursive: true });
    await withServer(root, (address, token) => {
      const open = (args, cwd = workspace, env = {}) => {
        const result = cli(root, ["open", ...args, "--json"], env, cwd);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toContain("opens within 5 minutes");
        expect(result.stderr).toContain("Choose an agent");
        return JSON.parse(result.stdout);
      };
      const first = open([folder]);
      expect(first).toEqual({
        ok: true,
        threadId: expect.any(String),
        created: true,
        folder,
        server: address,
        windowConnected: false,
        shown: "pending",
        agent: null,
        folderRecorded: true,
      });
      const reused = { ...first, created: false };
      expect(open([relative(root, folder)], root)).toEqual(reused);
      expect(open(["."], folder)).toEqual(reused);
      expect(open([], folder, { TOKAMAK_SERVER: address, TOKAMAK_TOKEN: token })).toEqual(reused);

      const fresh = open([folder, "--new", "--server", address], workspace, { TOKAMAK_TOKEN: token });
      expect(fresh).toEqual({ ...first, threadId: expect.any(String) });
      expect(fresh.threadId).not.toBe(first.threadId);
      expect(open([folder])).toEqual({ ...fresh, created: false });
    });
  });
}, 180_000);

const chatApi = createApi("chat");

test("open resolves a symlink before traversing its parent and rejects a redirected agent folder", async () => {
  await withPlugin(async (_, root) => {
    const sandbox = await prepareChatSandbox(root, { build: true });
    await cp(join(root, "plugins"), join(root, "installed"), { recursive: true });
    const outer = join(root, "outer");
    const child = join(outer, "child");
    const link = join(root, "link");
    const spaced = join(root, "name ");
    await mkdir(child, { recursive: true });
    await symlink(child, link, "dir");
    await mkdir(spaced);
    await mkdir(spaced.trimEnd());
    await withServer(
      root,
      async (address, token) => {
        const socket = new WebSocket(address.replace(/^http/, "ws") + "/ws", {
          headers: { Authorization: `Bearer ${token}` },
        });
        await new Promise((done, fail) => {
          socket.addEventListener("open", done, { once: true });
          socket.addEventListener("error", fail, { once: true });
        });
        const transport = new WebSocketTransport(socket);
        const client = new TokamakClient(transport);
        try {
          const opened = cli(root, ["open", link + "/..", "--json"]);
          expect(opened.code, opened.stderr).toBe(0);
          expect(JSON.parse(opened.stdout).folder).toBe(outer);
          const before = await client.query(chatApi.threads.list, {});
          const invalid = cli(root, ["open", spaced, "--new", "--json"]);
          expect(invalid.code).not.toBe(0);
          expect(JSON.parse(invalid.stdout).error.message).toContain("different folder");
          expect(await client.query(chatApi.threads.list, {})).toEqual(before);

          const threadId = await client.action(chatApi.threads.create, {});
          const agent = { plugin: "acp", backendId: "claude" };
          const settings = await client.action(chatApi.backends.configure, {
            ...agent,
            settings: { cwd: link + "/" },
          });
          await client.mutation(chatApi.threads.setBackend, {
            threadId,
            backend: { kind: "plugin", ...agent, settings },
          });
          const reused = cli(root, ["open", child, "--json"]);
          expect(reused.code, reused.stderr).toBe(0);
          expect(JSON.parse(reused.stdout)).toMatchObject({ threadId, created: false });
          await expect(
            client.mutation(chatApi.open.record, { threadId, backend: { settings } }),
          ).rejects.toThrow();
          expect(await client.query(chatApi.threads.list, {})).toHaveLength(before.length + 1);
          const previous = await client.query(chatApi.open.latest, {});
          const newer = await client.action(chatApi.open.request, { folder: child });
          expect(await client.query(chatApi.open.status, { requestId: previous._id })).toBe("replaced");
          expect(await client.query(chatApi.open.status, { requestId: newer.requestId })).toBe("pending");
          await client.mutation(chatApi.open.shown, { requestId: newer.requestId });
          expect(await client.query(chatApi.open.latest, {})).toBeNull();
          expect(await client.query(chatApi.open.status, { requestId: newer.requestId })).toBe(
            "acknowledged",
          );

          const starterId = await client.mutation(chatApi.threads.insert, { starterFolder: child });
          await client.mutation(chatApi.threads.setBackend, {
            threadId: starterId,
            backend: { kind: "plugin", ...agent, settings },
          });
          const starter = (await client.query(chatApi.threads.list, {})).find(({ _id }) => _id === starterId);
          expect(starter).toMatchObject({ backend: { settings } });
          expect(starter).not.toHaveProperty("starterFolder");
        } finally {
          transport.close();
        }
      },
      sandbox.env,
    );
  });
}, 180_000);
