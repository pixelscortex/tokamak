import { expect, test } from "bun:test";
import { chmod, cp, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, toNamespacedPath } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { withPlugin, workspace } from "../../build/tests/outside-fixture.mjs";
import { createApi, TokamakClient, WebSocketTransport } from "../../sdk/src/index";
import { cli } from "./cli-fixture.mjs";
import { version as tokamakVersion } from "../package.json";

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
        reloadRequired: true,
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
      reloadRequired: true,
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
      expect.arrayContaining([
        "plugin build",
        "plugin pack",
        "plugin add",
        "plugin remove",
        "plugin list",
        "plugin reload",
        "plugin logs",
        "invite",
        "members",
        "revoke",
        "server start",
        "server stop",
        "server status",
      ]),
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

function serverBinary() {
  const target = resolve(workspace, process.env.CARGO_TARGET_DIR ?? "target");
  return join(target, "debug", process.platform === "win32" ? "tokamak-server.exe" : "tokamak-server");
}

async function withServer(root, check, { killed = false, ...overrides } = {}) {
  const data = join(root, "data");
  const plugins = join(root, "installed");
  await mkdir(plugins, { recursive: true });
  await mkdir(data, { recursive: true });
  const token = randomBytes(32).toString("hex");
  const tokenFile = join(data, "server.token");
  await writeFile(tokenFile, token);
  if (process.platform !== "win32") await chmod(tokenFile, 0o600);
  const binary = serverBinary();
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
    await check(address, token, server);
  } finally {
    try {
      if (address && !killed) {
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

test("reload tells the user how to add an unknown plugin", async () => {
  await withPlugin((_, root) => {
    const result = cli(root, ["plugin", "reload", "missing", "--json"]);
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: { message: expect.stringContaining("missing"), next: "tokamak plugin add" },
    });
  });
});

test("pack reports the source location of a failed build without writing a ZIP", async () => {
  await withPlugin(async (plugin, root) => {
    const file = join(plugin, "src/server/broken.ts");
    await writeFile(file, "\nexport const broken: string = 42;\n");
    const result = cli(root, ["plugin", "pack", plugin, "--json"], {}, root);
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        message: "Plugin build failed",
        next: "tokamak plugin pack --help",
        diagnostics: expect.arrayContaining([expect.objectContaining({ file, line: 2 })]),
      },
    });
    expect(result.stderr).toContain(`${file}:2:`);
    expect(await readdir(root)).toEqual(["plugin"]);
  });
});

test("reload applies index additions and removals without a restart", async () => {
  await withPlugin(async (plugin, root) => {
    const run = (...args) => {
      const result = cli(root, ["plugin", ...args, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const dist = join(plugin, "dist");
    await mkdir(dist);
    await writeFile(join(dist, "stale.txt"), "An old file left in dist");
    const pack = (cwd, ...args) => {
      const result = cli(root, ["plugin", "pack", ...args, "--json"], {}, cwd);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain("Packed outside-fixture");
      return JSON.parse(result.stdout);
    };
    const packed = pack(root, "plugin");
    const zip = join(root, "outside-fixture-0.1.0.zip");
    expect(packed).toEqual({
      ok: true,
      path: zip,
      id: "outside-fixture",
      version: "0.1.0",
      buildId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(pack(plugin).buildId).toBe(packed.buildId);
    const unzip = (...args) => {
      const result = Bun.spawnSync(["unzip", ...args]);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout;
    };
    const manifest = unzip("-p", zip, "manifest.json");
    const { plugin: metadata, hashes } = JSON.parse(manifest.toString());
    expect(metadata.api).toBe(`tokamak@${tokamakVersion}`);
    expect(packed.buildId).toBe(digest(manifest));
    expect(unzip("-Z1", zip).toString().trimEnd().split("\n").sort()).toEqual(
      ["manifest.json", ...Object.keys(hashes)].sort(),
    );
    for (const [name, hash] of Object.entries(hashes)) {
      const bytes = unzip("-p", zip, name);
      expect(digest(bytes)).toBe(hash);
      if (name.endsWith(".map")) expect(JSON.parse(bytes.toString())).not.toHaveProperty("sourcesContent");
    }

    await withServer(root, async () => {
      run("add", plugin);
      expect(run("reload", "outside-fixture")).toMatchObject({
        plugins: [{ id: "outside-fixture", status: "loaded", buildId: packed.buildId }],
      });
      expect(run("list").plugins).toEqual([{ id: "outside-fixture", version: "0.1.0", fromIndex: true }]);
      expect(run("reload", "outside-fixture").plugins).toEqual([
        { id: "outside-fixture", status: "unchanged", buildId: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ]);
      const unrelated = join(root, "installed", "unrelated", "dist");
      await mkdir(unrelated, { recursive: true });
      await writeFile(join(unrelated, "manifest.json"), "{}");
      run("remove", "outside-fixture");
      expect(run("reload")).toMatchObject({
        plugins: [],
        removed: ["outside-fixture"],
        warnings: [expect.stringContaining("unrelated")],
      });
      expect(run("list").plugins).toEqual([]);
    });
  });
}, 180_000);

test("reload updates an existing connection and preserves old code on build or load failure", async () => {
  await withPlugin(async (plugin, root) => {
    const peer = join(root, "peer");
    await cp(plugin, peer, { recursive: true });
    const descriptor = join(peer, "plugin.ts");
    await writeFile(
      descriptor,
      (await readFile(descriptor, "utf8")).replace("outside-fixture", "reload-peer"),
    );
    const notes = join(plugin, "src/server/notes.ts");
    const original = await readFile(notes, "utf8");
    const marker = (source, value) =>
      source + `\nexport const marker = query({ handler: () => ${JSON.stringify(value)} });\n`;
    await writeFile(notes, marker(original, "old"));
    await writeFile(join(peer, "src/server/notes.ts"), marker(original, "peer"));
    const run = (...args) => {
      const result = cli(root, ["plugin", ...args, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    run("build", plugin);
    run("add", plugin);
    await withServer(root, async (address, token) => {
      const socket = new WebSocket(address.replace(/^http:/, "ws:") + "/ws?token=" + token);
      let transport;
      try {
        await new Promise((resolve, reject) => {
          const signal = AbortSignal.timeout(30_000);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          socket.addEventListener("open", resolve, { once: true, signal });
          socket.addEventListener("error", () => reject(new Error("WebSocket startup failed")), {
            once: true,
            signal,
          });
        });
        transport = new WebSocketTransport(socket);
        const client = new TokamakClient(transport);
        const api = createApi("outside-fixture");
        const read = () => client.query(api.notes.marker, {});
        expect(await read()).toBe("old");
        await writeFile(notes, marker(original, "edited"));
        expect(run("reload", "outside-fixture")).toMatchObject({
          ok: true,
          plugins: [
            { id: "outside-fixture", status: "loaded", buildId: expect.stringMatching(/^[a-f0-9]{64}$/) },
          ],
        });
        expect(await read()).toBe("edited");

        for (let i = 0; i < 2; i++) await client.mutation(api.notes.add, { text: "duplicate" });
        const schema = join(plugin, "src/server/schema.ts");
        await writeFile(
          schema,
          (await readFile(schema, "utf8")).replace(
            "defineTable({ text: v.string() })",
            'defineTable({ text: v.string() }).unique("by_text", ["text"])',
          ),
        );
        await writeFile(notes, marker(original, "refused"));
        const refused = cli(root, ["plugin", "reload", "outside-fixture", "--json"]);
        expect(refused.code).not.toBe(0);
        expect(JSON.parse(refused.stdout)).toMatchObject({
          ok: false,
          plugins: [
            {
              id: "outside-fixture",
              status: "load-failed",
              error: { message: expect.stringContaining("by_text") },
            },
          ],
        });
        expect(await read()).toBe("edited");
        run("add", peer);
        const refusedBatch = cli(root, ["plugin", "reload", "--json"]);
        expect(refusedBatch.code).not.toBe(0);
        expect(JSON.parse(refusedBatch.stdout).plugins).toEqual([
          expect.objectContaining({
            id: "outside-fixture",
            status: "load-failed",
            error: { message: expect.stringContaining("duplicate") },
          }),
          expect.objectContaining({ id: "reload-peer", status: "load-failed" }),
        ]);
        expect(run("list").plugins.map(({ id }) => id)).toEqual(["outside-fixture"]);

        await writeFile(join(plugin, "src/server/broken.ts"), "\nexport const broken: string = 42;\n");
        const broken = cli(root, ["plugin", "reload", "outside-fixture", "--json"]);
        const diagnostic = { file: expect.stringMatching(/broken\.ts$/), line: 2, code: "TS2322" };
        expect(broken.code).not.toBe(0);
        expect(JSON.parse(broken.stdout)).toMatchObject({
          ok: false,
          plugins: [{ id: "outside-fixture", status: "build-failed", error: { diagnostics: [diagnostic] } }],
        });
        expect(await read()).toBe("edited");

        run("add", peer);
        const batch = cli(root, ["plugin", "reload", "--json"]);
        expect(batch.code).not.toBe(0);
        expect(JSON.parse(batch.stdout)).toMatchObject({
          ok: false,
          plugins: [
            { id: "outside-fixture", status: "build-failed", error: { diagnostics: [diagnostic] } },
            { id: "reload-peer", status: "loaded" },
          ],
        });
        expect(await read()).toBe("edited");
        expect(await client.query(createApi("reload-peer").notes.marker, {})).toBe("peer");
      } finally {
        if (transport) transport.close();
        else socket.close();
      }
    });
  });
}, 180_000);

test("reload refuses a different manifest and verifies the bytes under a matching manifest", async () => {
  await withPlugin(async (folder, root) => {
    const build = () => {
      const result = cli(root, ["plugin", "build", folder, "--json"]);
      expect(result.code, result.stderr).toBe(0);
    };
    expect(cli(root, ["plugin", "add", folder]).code).toBe(0);
    build();
    const manifest = join(folder, "dist", "manifest.json");
    const old = await readFile(manifest);
    const hash = (bytes) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    await withServer(root, async (address, token) => {
      const submit = (buildId) =>
        fetch(address + "/plugin-index/reload", {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ builds: [{ id: "outside-fixture", buildId }], removeMissing: false }),
        });
      const notes = join(folder, "src/server/notes.ts");
      await writeFile(
        notes,
        (await readFile(notes, "utf8")) + "\nexport const marker = query({ handler: () => 42 });",
      );
      build();
      const stale = await submit(hash(old));
      expect(stale.status).toBe(400);
      expect((await stale.json()).error).toContain("build changed after this reload started");
      await writeFile(manifest, old);
      const mixed = await submit(hash(old));
      expect(mixed.status).toBe(400);
      expect((await mixed.json()).error).toContain("hash mismatch");
    });
  });
}, 180_000);

test("legacy reload leaves indexed snapshots alone and ignores new index entries", async () => {
  await withPlugin(async (folder, root) => {
    const installed = join(root, "installed", "base");
    await mkdir(join(root, "installed"));
    await cp(folder, installed, { recursive: true });
    const id = join(installed, "plugin.ts");
    await writeFile(id, (await readFile(id, "utf8")).replace("outside-fixture", "base-plugin"));
    expect(cli(root, ["plugin", "build", installed]).code).toBe(0);
    await withServer(root, async (address, token) => {
      expect(cli(root, ["plugin", "add", folder]).code).toBe(0);
      await mkdir(join(folder, "dist"), { recursive: true });
      await writeFile(join(folder, "dist", "manifest.json"), "{}");
      const res = await fetch(address + "/plugins/base-plugin/reload", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).plugins.map(({ plugin }) => plugin.id)).toEqual(["base-plugin"]);
    });
  });
}, 180_000);

function spawnReload(root, token, address) {
  const args = ["plugin", "reload", "outside-fixture", "--json"];
  if (address) args.push("--server", address);
  const child = Bun.spawn([process.execPath, "packages/cli/src/main.ts", ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      TOKAMAK_SERVER_DIR: join(root, "data"),
      TOKAMAK_SERVER: undefined,
      TOKAMAK_TOKEN: token,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 90_000,
  });
  return Promise.all([child.exited, new Response(child.stdout).json(), new Response(child.stderr).text()]);
}

for (const scenario of ["race", "timeout", "death"]) {
  test(`reload ${scenario}: reports only what the server is known to run`, async () => {
    await withPlugin(async (folder, root) => {
      expect(cli(root, ["plugin", "add", folder]).code).toBe(0);
      const notes = join(folder, "src/server/notes.ts");
      const original = await readFile(notes, "utf8");
      const edit = (n) =>
        writeFile(notes, original + `\nexport const marker = query({ handler: () => ${n} });`);
      await withServer(
        root,
        async (address, token, server) => {
          const arrived = Promise.withResolvers();
          const release = Promise.withResolvers();
          let applied;
          const proxy = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            idleTimeout: 0,
            async fetch(req, self) {
              const path = new URL(req.url).pathname;
              if (req.method === "GET") return fetch(address + path, { headers: req.headers });
              const body = await req.text();
              if (scenario === "race") {
                arrived.resolve(JSON.parse(body).builds[0].buildId);
                await release.promise;
              }
              const res = await fetch(address + path, { method: "POST", headers: req.headers, body });
              applied = (await res.clone().json()).plugins?.[0]?.revision;
              if (scenario === "timeout") await release.promise;
              if (scenario === "death") {
                server.kill("SIGKILL");
                await server.exited;
                self.stop(true);
              }
              return res;
            },
          });
          try {
            await edit(1);
            const first = spawnReload(root, token, proxy.url.origin);
            if (scenario === "race") {
              const firstId = await Promise.race([
                arrived.promise,
                first.then((result) => {
                  throw new Error(JSON.stringify(result));
                }),
              ]);
              await edit(2);
              const second = spawnReload(root, token);
              expect(
                await Promise.race([second.then(() => "completed"), Bun.sleep(500).then(() => "waiting")]),
              ).toBe("waiting");
              expect(
                new Bun.CryptoHasher("sha256")
                  .update(await readFile(join(folder, "dist/manifest.json")))
                  .digest("hex"),
              ).toBe(firstId);
              release.resolve();
              const [firstCode, firstResult] = await first;
              const [secondCode, secondResult] = await second;
              expect(firstCode).toBe(0);
              expect(secondCode).toBe(0);
              expect(firstResult.plugins[0]).toMatchObject({ buildId: firstId, status: "loaded" });
              expect(secondResult.plugins[0].buildId).not.toBe(firstId);
            } else {
              const [code, result, stderr] = await first;
              expect(applied).toMatch(/^[a-f0-9]{64}$/);
              expect(code === 0).toBe(scenario === "timeout");
              expect(result.plugins[0]).toMatchObject({
                buildId: applied,
                status: scenario === "timeout" ? "loaded" : "unknown",
              });
              if (scenario === "death") expect(stderr).toContain("tokamak plugin list");
            }
          } finally {
            release.resolve();
            proxy.stop(true);
          }
        },
        { killed: scenario === "death" },
      );
    });
  }, 180_000);
}

test("batch fallback loads a provider before its dependent after a third plugin is refused", async () => {
  await withPlugin(async (folder, root) => {
    const create = async (id, extra = "") => {
      const path = join(root, id);
      await cp(folder, path, { recursive: true });
      await writeFile(
        join(path, "plugin.ts"),
        `import { definePlugin } from "@tokamak/sdk"; export default definePlugin({ id: "${id}", version:"1.0.0"${extra} });`,
      );
      expect(cli(root, ["plugin", "add", path]).code).toBe(0);
      return path;
    };
    await create("dependent", ', depends: ["provider"]');
    await create("provider");
    const refused = await create("refused");
    const notes = join(refused, "src/server/notes.ts");
    await writeFile(notes, (await readFile(notes, "utf8")) + '\nthrow new Error("refused at import");');
    await withServer(root, () => {
      const output = cli(root, ["plugin", "reload", "--json"]);
      expect(output.code).not.toBe(0);
      expect(JSON.parse(output.stdout).plugins).toEqual([
        expect.objectContaining({ id: "dependent", status: "loaded" }),
        expect.objectContaining({ id: "provider", status: "loaded" }),
        expect.objectContaining({
          id: "refused",
          status: "load-failed",
          error: { message: expect.stringContaining("refused at import") },
        }),
      ]);
    });
  });
}, 180_000);

test("reload refuses a worker that throws during import and keeps the old worker", async () => {
  await withPlugin(async (_, root) => {
    const folder = join(root, "worker-test");
    await cp(join(workspace, "packages/server/tests/fixtures/worker"), folder, { recursive: true });
    await symlink(join(workspace, "node_modules"), join(folder, "node_modules"), "dir");
    expect(cli(root, ["plugin", "add", folder]).code).toBe(0);
    await withServer(root, async (address, token) => {
      const reload = () => cli(root, ["plugin", "reload", "worker-test", "--json"]);
      expect(reload().code).toBe(0);
      const socket = new WebSocket(address.replace(/^http:/, "ws:") + "/ws?token=" + token);
      await new Promise((done, reject) => {
        socket.addEventListener("open", done, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      const transport = new WebSocketTransport(socket);
      try {
        const state = () => new TokamakClient(transport).action(createApi("worker-test").actions.state, {});
        const old = await state();
        const actions = join(folder, "src/server/actions.ts");
        await writeFile(
          actions,
          'if (typeof process !== "undefined") throw new Error("worker import failed intentionally");\n' +
            (await readFile(actions, "utf8")),
        );
        const refused = reload();
        expect(refused.code).not.toBe(0);
        expect(JSON.parse(refused.stdout).plugins[0]).toMatchObject({
          status: "load-failed",
          error: { message: expect.stringContaining("worker import failed intentionally") },
        });
        expect((await state()).pid).toBe(old.pid);
      } finally {
        transport.close();
      }
    });
  });
}, 180_000);

test("reload reports skipped plugins separately unless the command asked for them", async () => {
  await withPlugin(async (folder, root) => {
    const broken = join(root, "broken");
    await cp(folder, broken, { recursive: true });
    const descriptor = join(broken, "plugin.ts");
    await writeFile(
      descriptor,
      (await readFile(descriptor, "utf8")).replace("outside-fixture", "skipped-plugin"),
    );
    const notes = join(broken, "src/server/notes.ts");
    await writeFile(notes, (await readFile(notes, "utf8")) + '\nthrow new Error("still skipped");');
    for (const path of [folder, broken]) {
      expect(cli(root, ["plugin", "build", path]).code).toBe(0);
      expect(cli(root, ["plugin", "add", path]).code).toBe(0);
    }
    await withServer(root, () => {
      const other = cli(root, ["plugin", "reload", "outside-fixture", "--json"]);
      expect(other.code, other.stderr).toBe(0);
      expect(JSON.parse(other.stdout)).toMatchObject({
        plugins: [{ id: "outside-fixture", status: "unchanged" }],
        skipped: { "skipped-plugin": expect.stringContaining("still skipped") },
      });
      const selected = cli(root, ["plugin", "reload", "skipped-plugin", "--json"]);
      expect(selected.code).not.toBe(0);
      expect(JSON.parse(selected.stdout)).toMatchObject({
        plugins: [
          {
            id: "skipped-plugin",
            status: "load-failed",
            error: { message: expect.stringContaining("still skipped") },
          },
        ],
        skipped: {},
      });
    });
  });
}, 180_000);

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
      const source = join(plugin, "src/server/failure.ts");
      const original = await readFile(source, "utf8");
      const reload = () => run("reload", "outside-fixture");
      const baseline = run("logs", "outside-fixture").entries;
      expect(reload().plugins[0].status).toBe("unchanged");
      expect(run("logs", "outside-fixture").entries).toEqual(baseline);
      expect(readBurst()).toEqual(burst);

      const changed = original + "\nexport const version = query({ handler: () => 2 });\n";
      await writeFile(source, changed);
      expect(reload().plugins[0].status).toBe("loaded");
      expect(run("logs", "outside-fixture").entries).toEqual([]);
      expect(readBurst()).toEqual(burst);
      expect((await report("outside-fixture", "stale view")).status).toBe(409);

      const active = invoke(address, token, "action", "outside-fixture/failure:wait");
      const logFile = join(root, "logs", "outside-fixture.log");
      const deadline = Date.now() + 10_000;
      while (!(await readFile(logFile, "utf8")).includes("old running action")) {
        if (Date.now() > deadline) throw new Error("Old action never started");
        await Bun.sleep(20);
      }
      await writeFile(source, 'console.info("new initializer");\n' + changed);
      expect(reload().plugins[0].status).toBe("loaded");
      expect((await active).Err).toContain("Plugin action cancelled by reload");
      expect(run("logs", "outside-fixture").entries.map(({ text }) => text)).toEqual(["new initializer"]);
      await writeFile(
        source,
        'console.info("rejected initializer"); throw new Error("reject candidate");\n' + original,
      );
      const refused = cli(root, ["plugin", "reload", "outside-fixture", "--json"]);
      expect(refused.code).not.toBe(0);
      expect(JSON.parse(refused.stdout).plugins[0]).toMatchObject({
        status: "load-failed",
        error: { message: expect.stringContaining("reject candidate") },
      });
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
            const source = join(plugin, "src/server/marker.ts");
            await writeFile(
              source,
              (await readFile(source, "utf8")) + "\nexport const version = query({ handler: () => 2 });\n",
            );
            expect(cli(root, ["plugin", "build", plugin]).code).toBe(0);
            await cp(join(plugin, "dist"), join(b, "installed", "fixture", "dist"), { recursive: true });
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

test("members explains how to start a missing local server", async () => {
  await withPlugin((_, root) => {
    const result = cli(root, ["members", "--json"]);
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout).error.next).toBe("tokamak server start");
  });
});

test("the owner can invite and revoke a member who can connect", async () => {
  await withPlugin((_, root) =>
    withServer(root, async (address, ownerToken) => {
      const invited = cli(root, ["invite", "Alice", "--json"]);
      expect(invited.code).toBe(0);
      const { invite } = JSON.parse(invited.stdout);
      expect(typeof invite === "string" && /^[a-f0-9]{64}$/.test(invite)).toBe(true);
      expect(invited.stderr.includes(invite)).toBe(false);
      expect(invited.stderr.trim() === "Invite created.").toBe(true);
      const human = cli(root, ["invite", "Human Output"]);
      expect(human.code).toBe(0);
      expect(/^[a-f0-9]{64}\n$/.test(human.stdout)).toBe(true);
      expect(human.stderr === "").toBe(true);
      const bearer = { authorization: `Bearer ${invite}` };
      const memberResponse = (path) => fetch(`${address}${path}`, { headers: bearer });
      expect((await memberResponse("/health")).status).toBe(403);
      expect((await memberResponse("/account")).status).toBe(200);
      const socket = new WebSocket(`${address.replace(/^http:/, "ws:")}/ws`, { headers: bearer });
      const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("Member connection failed")), { once: true });
      });
      try {
        const existing = cli(root, ["server", "start", "--json"], {
          TOKAMAK_PLUGIN_DIR: join(root, "installed"),
        });
        expect(existing.code, existing.stderr).toBe(0);
        expect(JSON.parse(existing.stdout).reused).toBe(true);
        const owner = { TOKAMAK_SERVER: address, TOKAMAK_TOKEN: ownerToken };
        const listed = cli(root, ["members", "--json"], owner);
        expect(listed.code).toBe(0);
        const { members } = JSON.parse(listed.stdout);
        const alice = members.find(({ name }) => name === "Alice");
        expect(typeof alice?.id).toBe("string");
        expect(alice.role).toBe("member");
        for (const args of [["invite", "Bob"], ["members"], ["revoke", alice.id]]) {
          const denied = cli(root, [...args, "--json", "--server", address], {
            TOKAMAK_SERVER: "http://127.0.0.1:1",
            TOKAMAK_TOKEN: invite,
          });
          expect(denied.code).not.toBe(0);
          expect(JSON.parse(denied.stdout).error.message).toContain("Only the owner");
        }
        for (const [id, message] of [
          ["00000000-0000-4000-8000-000000000000", "Unknown member"],
          ["planted-invalid-id", "Invalid member id"],
          ["local", "The owner cannot be revoked"],
        ]) {
          const invalid = cli(root, ["revoke", id, "--json"], owner);
          expect(invalid.code).not.toBe(0);
          expect(JSON.parse(invalid.stdout).error).toEqual({ message, next: "tokamak members" });
        }
        const revoked = cli(root, ["revoke", alice.id, "--json"], owner);
        expect(revoked.code, JSON.parse(revoked.stdout).error?.message).toBe(0);
        expect(JSON.parse(revoked.stdout)).toEqual({ ok: true, revoked: alice.id });
        expect(await Promise.race([closed.then(() => true), Bun.sleep(10_000).then(() => false)])).toBe(true);
        expect((await memberResponse("/account")).status).toBe(401);
        const remaining = cli(root, ["members", "--json"]);
        expect(remaining.code).toBe(0);
        expect(JSON.parse(remaining.stdout).members.some(({ id }) => id === alice.id)).toBe(false);
      } finally {
        socket.close();
      }
    }),
  );
}, 120_000);

test("the CLI starts one desktop-compatible local server and stops it", async () => {
  await withPlugin(async (_, root) => {
    const plugins = join(root, "installed");
    await mkdir(plugins);
    const run = (...args) => {
      const result = cli(root, ["server", ...args, "--json"], { TOKAMAK_PLUGIN_DIR: plugins });
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    try {
      expect(run("status")).toEqual({ ok: true, running: false });
      const started = run("start");
      const { address, pid, buildId } = started;
      expect(started.ok).toBe(true);
      expect(started.reused).toBe(false);
      expect(address).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(buildId).toMatch(/^[a-f0-9]{64}$/);
      expect(run("start")).toEqual({ ...started, reused: true });
      expect(run("status")).toEqual({ ok: true, running: true, responsive: true, address, pid, buildId });

      // Desktop reuse requires matching health, discovery, binary build, and plugin root.
      const discovery = JSON.parse(await readFile(join(root, "data", "server.json"), "utf8"));
      const token = await readFile(join(root, "data", "server.token"), "utf8");
      const health = await fetch(new URL("/health", address.replace(/^ws:/, "http:")), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(await health.json()).toEqual(discovery);
      const binary = serverBinary();
      const build = Bun.spawnSync([binary, "--build-id"], { cwd: root });
      expect(build.exitCode).toBe(0);
      expect(discovery).toMatchObject({
        pid,
        url: address,
        buildId: build.stdout.toString().trim(),
        pluginRoot: toNamespacedPath(await realpath(plugins)),
      });
      expect(buildId).toBe(discovery.buildId);
      expect(run("stop")).toEqual({ ok: true, stopped: true });
      expect(run("status")).toEqual({ ok: true, running: false });
      expect(run("stop")).toEqual({ ok: true, stopped: false });
    } finally {
      cli(root, ["server", "stop"]);
    }
  });
}, 150_000);

test("a shared server invite is a join link", async () => {
  await withPlugin(async (_, root) => {
    const owner = randomBytes(32).toString("hex");
    const web = join(root, "web");
    const plugins = join(root, "installed");
    await mkdir(web);
    await mkdir(plugins);
    await writeFile(join(web, "index.html"), "<title>Tokamak</title>");
    const server = Bun.spawn(
      [
        serverBinary(),
        "--listen",
        "127.0.0.1:0",
        "--web",
        web,
        "--plugins",
        plugins,
        "--data",
        join(root, "store"),
      ],
      {
        cwd: root,
        env: { ...process.env, TOKAMAK_ACCESS_TOKEN: owner, TOKAMAK_PUBLIC_URL: undefined },
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const ready = async () => {
      let output = "";
      for await (const chunk of server.stdout) {
        output += Buffer.from(chunk).toString();
        const address = /Tokamak listening on ws:\/\/(127\.0\.0\.1:\d+)\/ws/.exec(output)?.[1];
        if (address) return `http://${address}`;
      }
      throw new Error("Shared server exited before readiness");
    };
    let address;
    let timeout;
    try {
      address = await Promise.race([
        ready(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Shared server did not become ready")), 60_000);
        }),
      ]);
      const invite = cli(root, ["invite", "Alice", "--json"], {
        TOKAMAK_SERVER: address,
        TOKAMAK_TOKEN: owner,
      });
      expect(invite.code).toBe(0);
      const link = new URL(JSON.parse(invite.stdout).invite);
      expect(link.origin).toBe(address);
      expect(link.pathname).toBe("/join");
      const account = await fetch(`${address}/account`, {
        headers: { authorization: `Bearer ${link.hash.slice(1)}` },
      });
      expect(account.status).toBe(200);
      expect(await account.json()).toMatchObject({ name: "Alice", role: "member" });
    } finally {
      clearTimeout(timeout);
      if (server.exitCode === null) {
        if (address) {
          await fetch(`${address}/shutdown`, {
            headers: { authorization: `Bearer ${owner}` },
            method: "POST",
            signal: AbortSignal.timeout(5000),
          }).catch(() => {});
        } else {
          server.kill();
        }
        const exit = await Promise.race([server.exited, Bun.sleep(5000).then(() => null)]);
        if (exit === null) server.kill("SIGKILL");
      }
      await server.exited;
    }
  });
}, 120_000);

test("the server executable only advertises run flags and rejects the moved subcommands", async () => {
  await withPlugin((_, root) => {
    const help = Bun.spawnSync([serverBinary(), "--help"], { cwd: root });
    expect(help.exitCode).toBe(0);
    const usage = help.stdout.toString().trim();
    expect(usage.split("\n")).toHaveLength(1);
    expect(usage).toStartWith("tokamak-server (--plugins");
    for (const command of ["invite", "members", "revoke"]) {
      expect(usage).not.toMatch(new RegExp(`\\b${command}\\b`));
      const result = Bun.spawnSync([serverBinary(), command, "unused"], { cwd: root });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(`unknown option ${command}`);
    }
    expect(usage).not.toContain("plugin reload");
    const reload = Bun.spawnSync([serverBinary(), "plugin", "reload", "unused"], { cwd: root });
    expect(reload.exitCode).not.toBe(0);
    expect(reload.stderr.toString()).toContain("tokamak plugin reload");
  });
});

function lifecycle(root, args, extra = {}) {
  const child = Bun.spawn([process.execPath, "packages/cli/src/main.ts", "server", ...args, "--json"], {
    cwd: workspace,
    env: { ...process.env, TOKAMAK_SERVER_DIR: join(root, "data"), ...extra },
    stdout: "pipe",
    stderr: "ignore",
    timeout: 110_000,
  });
  return Promise.all([child.exited, new Response(child.stdout).text()]).then(([code, stdout]) => ({
    code,
    result: JSON.parse(stdout),
  }));
}

test("a live server without a health response still counts as running", async () => {
  await withPlugin(async (_, root) => {
    const data = join(root, "data");
    await mkdir(data);
    const unused = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const url = `ws://127.0.0.1:${unused.port}/ws`;
    await unused.stop(true);
    await writeFile(join(data, "server.token"), "a".repeat(64), { mode: 0o600 });
    await writeFile(
      join(data, "server.json"),
      JSON.stringify({ url, pid: process.pid, bundleHash: "a".repeat(64) }),
    );
    expect(await lifecycle(root, ["status"])).toEqual({
      code: 0,
      result: { ok: true, running: true, responsive: false, address: url, pid: process.pid, buildId: null },
    });
  });
});

test("start identifies the build command for an unbuilt plugin", async () => {
  await withPlugin(async (_, root) => {
    const plugins = join(root, "installed");
    const folder = join(plugins, "example");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "package.json"), "{}");
    try {
      const started = await lifecycle(root, ["start"], { TOKAMAK_PLUGIN_DIR: plugins });
      expect(started.code).not.toBe(0);
      expect(started.result.error.next).toContain("tokamak plugin build");
      expect(started.result.error.next).toContain(folder);
    } finally {
      await lifecycle(root, ["stop"]);
    }
  });
}, 130_000);

test.skipIf(process.platform === "win32")(
  "overlapping starts share one server and stop waits for startup",
  async () => {
    await withPlugin(async (_, root) => {
      const target = join(root, "target");
      const debug = join(target, "debug");
      const plugins = join(root, "installed");
      await mkdir(debug, { recursive: true });
      await mkdir(plugins);
      await writeFile(
        join(debug, "tokamak-server"),
        `#!/bin/sh
if env | grep -Eq '^TOKAMAK_(TOKEN|ACCESS_TOKEN|SERVER)='; then
  touch "$FIXTURE_ROOT/leaked"
fi
touch "$FIXTURE_ROOT/probe-$$"
if [ "$1" != "--build-id" ]; then
  touch "$FIXTURE_ROOT/entered"
  while [ ! -e "$FIXTURE_ROOT/release" ]; do sleep 0.05; done
fi
exec "$FIXTURE_BINARY" "$@"
`,
        { mode: 0o700 },
      );
      const env = {
        CARGO_TARGET_DIR: target,
        TOKAMAK_PLUGIN_DIR: plugins,
        TOKAMAK_TOKEN: "planted-cli-token",
        TOKAMAK_ACCESS_TOKEN: "planted-owner-token",
        TOKAMAK_SERVER: "http://127.0.0.1:1",
        FIXTURE_ROOT: root,
        FIXTURE_BINARY: serverBinary(),
      };
      const start = () => lifecycle(root, ["start"], env);
      const release = join(root, "release");
      const entered = join(root, "entered");
      const { readdir, unlink } = await import("node:fs/promises");
      async function until(ready) {
        const deadline = Date.now() + 40_000;
        while (!(await ready())) {
          if (Date.now() >= deadline) throw new Error("Server launcher did not reach the gate");
          await Bun.sleep(25);
        }
      }
      const starting = [];
      try {
        starting.push(start());
        await until(() => Bun.file(entered).exists());
        starting.push(start());
        await until(
          async () => (await readdir(root)).filter((name) => name.startsWith("probe-")).length >= 3,
        );
        await writeFile(release, "");
        const results = await Promise.all(starting);
        expect(results.map(({ code }) => code)).toEqual([0, 0]);
        expect(results[0].result.pid).toBe(results[1].result.pid);
        expect(results.map(({ result }) => result.reused).sort()).toEqual([false, true]);
        expect((await lifecycle(root, ["stop"])).result.stopped).toBe(true);

        await unlink(release);
        await unlink(entered);
        const restarted = start();
        starting.push(restarted);
        await until(() => Bun.file(entered).exists());
        const stopping = lifecycle(root, ["stop"]);
        const early = await Promise.race([stopping.then(() => true), Bun.sleep(1500).then(() => false)]);
        await writeFile(release, "");
        expect((await restarted).code).toBe(0);
        expect((await stopping).result.stopped).toBe(true);
        expect(early).toBe(false);
        expect((await lifecycle(root, ["status"])).result.running).toBe(false);
        expect(await Bun.file(join(root, "leaked")).exists()).toBe(false);
      } finally {
        await writeFile(release, "");
        await Promise.allSettled(starting);
        await lifecycle(root, ["stop"]);
      }
    });
  },
  180_000,
);

test("people errors do not echo upstream text and local lifecycle commands reject server selection", async () => {
  await withPlugin(async (_, root) => {
    for (const command of ["start", "status", "stop"]) {
      const { code, result } = await lifecycle(root, [command, "--server", "http://127.0.0.1:1"]);
      expect(code).not.toBe(0);
      expect(result.error.message).toContain("--server is only available");
    }
    const planted = "planted-untrusted-response";
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(planted, { status: 400 }),
    });
    try {
      const result = Bun.spawn(
        [process.execPath, "packages/cli/src/main.ts", "members", "--server", listener.url.origin, "--json"],
        {
          cwd: workspace,
          env: { ...process.env, TOKAMAK_SERVER_DIR: join(root, "data"), TOKAMAK_TOKEN: "planted-token" },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        result.exited,
        new Response(result.stdout).text(),
        new Response(result.stderr).text(),
      ]);
      expect(code).not.toBe(0);
      expect((stdout + stderr).includes(planted)).toBe(false);
      expect(JSON.parse(stdout).error).toEqual({
        message: "Could not list members: Server returned HTTP 400",
        next: "tokamak members --help",
      });
    } finally {
      await listener.stop(true);
    }
  });
}, 60_000);

function diagnosticCli(root, args, extra = {}, cwd = root, preload = []) {
  const result = Bun.spawnSync(
    [process.execPath, ...preload, join(workspace, "packages/cli/src/main.ts"), ...args],
    {
      cwd,
      timeout: 60_000,
      env: {
        ...process.env,
        TOKAMAK_SERVER: undefined,
        TOKAMAK_TOKEN: undefined,
        TOKAMAK_SERVER_DIR: join(root, "data"),
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("doctor shows all five checks when the local server is not running", async () => {
  await withPlugin((_, root) => {
    const result = diagnosticCli(root, ["doctor", "--json"], {}, root);
    expect(result.code).toBe(1);
    const { ok, error, rows } = JSON.parse(result.stdout);
    expect(ok).toBe(false);
    expect(error.next).toBe("tokamak server start");
    expect(rows.map(({ name }) => name)).toEqual([
      "Tokamak CLI",
      "Bun",
      "git",
      "Build tools",
      "Local server",
    ]);
    expect(rows.at(-1)).toEqual({
      name: "Local server",
      state: "not ready",
      detail: "Local server is not running or reachable.",
      fix: "tokamak server start",
    });
    const human = diagnosticCli(root, ["doctor"], {}, root);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain("Check");
    expect(human.stderr).toMatch(/Local server\s+not ready/);
    expect(human.stdout).toBe("");
    expect(result.stderr).toBe(human.stderr);
    for (const command of ["doctor", "report"]) {
      const rejected = diagnosticCli(root, [
        command,
        "--server",
        "http://user:FakeRejectedFlagSecret@127.0.0.1",
        "--json",
      ]);
      expect(rejected.code).toBe(1);
      expect(JSON.parse(rejected.stdout).error.message).toContain("--server");
      expect((rejected.stdout + rejected.stderr).includes("FakeRejectedFlagSecret")).toBe(false);
    }
  });
}, 45_000);

test("report works without a local server and refuses to replace an existing file", async () => {
  await withPlugin(async (_, root) => {
    const result = diagnosticCli(root, ["report"], {}, root);
    expect(result.code, result.stdout).toBe(0);
    const path = result.stdout.trim();
    expect(path).toMatch(/tokamak-report-.*\.md$/);
    expect(dirname(path)).toBe(root);
    const report = await readFile(path, "utf8");
    expect(report).toContain("Local server is not running");
    const duplicate = diagnosticCli(root, ["report", "--out", path, "--json"], {}, root);
    expect(duplicate.code).toBe(1);
    expect(JSON.parse(duplicate.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("already exists"), next: "tokamak report --help" },
    });
    expect(await readFile(path, "utf8")).toBe(report);
  });
}, 45_000);

test("doctor diagnoses missing git and compares the running Bun without starting proto or PATH bun", async () => {
  await withPlugin(async (_, root) => {
    const marker = join(root, "unexpected-tool-call");
    if (process.platform !== "win32") {
      for (const name of ["bun", "proto"]) {
        await writeFile(join(root, name), `#!/bin/sh\nprintf attempted > "${marker}"\nprintf 9.9.9\\n\n`, {
          mode: 0o700,
        });
      }
    }
    const preload = join(root, "version.mjs");
    await writeFile(preload, 'Object.defineProperty(process.versions, "bun", { value: "0.0.1" });');
    const result = diagnosticCli(root, ["doctor", "--json"], { PATH: root }, root, ["--preload", preload]);
    const pinned = /^bun\s*=\s*"([^"]+)"/m.exec(await readFile(join(workspace, ".prototools"), "utf8"))[1];
    expect(result.code).toBe(1);
    const { rows } = JSON.parse(result.stdout);
    expect(rows.find(({ name }) => name === "git")).toMatchObject({
      state: "not ready",
      fix: "https://git-scm.com/downloads",
    });
    expect(rows.find(({ name }) => name === "Bun")).toEqual({
      name: "Bun",
      state: "not ready",
      detail: `Running Bun 0.0.1; checkout pins ${pinned}.`,
      fix: `proto install bun ${pinned}`,
    });
    expect(await Bun.file(marker).exists()).toBe(false);
    const matching = diagnosticCli(root, ["doctor", "--json"], { PATH: root });
    expect(JSON.parse(matching.stdout).rows[1]).toMatchObject({
      state: "ready",
      detail: `Running Bun ${pinned}; checkout pins ${pinned}.`,
    });
  });
}, 45_000);

test("doctor is ready and report captures a real local server with credentials redacted", async () => {
  await withPlugin(async (plugin, root) => {
    for (const args of [
      ["plugin", "build", plugin],
      ["plugin", "add", plugin],
    ]) {
      const result = diagnosticCli(root, args, {}, root);
      expect(result.code, result.stdout).toBe(0);
    }
    await withServer(root, async (address, localToken) => {
      const data = join(root, "data");
      const { url, pid, buildId } = JSON.parse(await readFile(join(data, "server.json"), "utf8"));
      expect(url).toBe(address.replace(/^http:/, "ws:") + "/ws");
      const doctor = diagnosticCli(
        root,
        ["doctor", "--json"],
        { TOKAMAK_SERVER: "http://127.0.0.1:1" },
        root,
      );
      expect(doctor.code, doctor.stderr).toBe(0);
      const { ok, rows } = JSON.parse(doctor.stdout);
      expect(ok).toBe(true);
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row).toEqual({ name: expect.any(String), state: "ready", detail: expect.any(String) });
      }
      expect(rows.at(-1).detail).toContain(buildId);
      expect(rows.at(-1).detail).toContain(url);

      const invite = randomBytes(32).toString("hex");
      const envToken = "test-environment-secret-value";
      const authorization = "CustomScheme opaque-value abc";
      await writeFile(join(data, "invite.txt"), `${address}/join#${invite}`);
      const fullLog = [
        "before-the-tail",
        ...Array.from(
          { length: 193 },
          (_, i) => `2040-01-02T03:04:05.678Z INFO server: line ${i + 1}: ${"ordinary log data ".repeat(6)}`,
        ),
        `copied local credential: ${localToken}`,
        `copied invitation: ${await readFile(join(data, "invite.txt"), "utf8")}`,
        `unlabeled invitation credential: ${invite}`,
        `copied environment credential: ${envToken}`,
        `"Authorization": "${authorization}"`,
        "Authorization:",
        "  custom-folded-credential",
      ].join("\n");
      await writeFile(join(data, "server.log"), fullLog + "\n");

      const result = diagnosticCli(
        root,
        ["report", "--out", "diagnostics.md", "--json"],
        { TOKAMAK_TOKEN: envToken, TOKAMAK_SERVER: "http://127.0.0.1:1", HOME: root, USERPROFILE: root },
        root,
      );
      const path = join(root, "diagnostics.md");
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ ok: true, path });
      expect(result.stderr.trim()).toBe(path);
      const report = await readFile(path, "utf8");
      for (const detail of [
        "## Doctor",
        "Check          State",
        `Address: ${url}`,
        `Build id: ${buildId}`,
        `Process id: ${pid}`,
        "Data folder: ~/data",
        '"id": "outside-fixture"',
        '"version": "0.1.0"',
        '"fromIndex": true',
        '"outside-fixture": "~/plugin"',
        "## Operating system",
        process.arch,
        "line 1:",
        "line 193:",
        "Redaction was applied",
      ]) {
        expect(report).toContain(detail);
      }
      for (const excluded of [
        localToken,
        invite,
        envToken,
        authorization,
        "opaque-value",
        "custom-folded-credential",
        "before-the-tail",
      ]) {
        expect(report).not.toContain(excluded);
      }
    });
  });
}, 120_000);

test("report removes credentials from standard log messages and omits unstructured text", async () => {
  await withPlugin(async (_, root) => {
    const home = join(root, "private-account");
    const data = join(home, "data");
    await mkdir(data, { recursive: true });
    const token = "fake-env-token/+with spaces";
    const variants = [token, encodeURIComponent(token), Buffer.from(token).toString("base64")];
    const opaque = "uLWbs0nI7njIy/H9DsYA7+kkPv/w5rxL4HtX";
    const prefix = "2040-01-02T03:04:05.678Z INFO server: ";
    const lines = [
      ...variants.map((value) => prefix + value),
      prefix + opaque,
      prefix + "Authorization: FakeHeaderValue",
      prefix + "Authoriz\\u0061tion: FakeEscapedHeader",
      "Authori",
      "zation: FakeSplitHeader",
      "FakeUnindentedContinuation",
      prefix + "https://fake-user:FakeUserInfo@example.invalid/a?api_key=FakeQuery#FakeFragment",
      prefix + "https://example.invalid/a?%74oken=FakeEncodedQuery",
      prefix + '{"access_token":"FakeJsonToken","cookie":"FakeCookie"}',
      prefix + "env OTHER_KEY=FakeEnvironmentDump USER=fake-user",
      prefix + "ordinary message",
    ];
    await writeFile(
      join(data, "plugin-index.json"),
      JSON.stringify({
        sample: join(home, "project"),
        external: join(root, "another-account", "PrivateCheckoutName"),
      }),
    );
    await writeFile(join(data, "server.log"), lines.join("\n"));
    const result = diagnosticCli(root, ["report", "--out", "sanitized.md"], {
      HOME: home,
      USERPROFILE: home,
      TOKAMAK_SERVER_DIR: data,
      TOKAMAK_TOKEN: token,
    });
    expect(result.code, result.stderr).toBe(0);
    const report = await readFile(result.stdout.trim(), "utf8");
    for (const value of [
      ...variants,
      opaque,
      home,
      "PrivateCheckoutName",
      ...lines.flatMap((line) => line.match(/Fake[A-Za-z]+/g) ?? []),
    ]) {
      expect(report.includes(value)).toBe(false);
    }
    expect(report).toContain("[omitted unrecognized log line:");
    expect(report).toContain(prefix + "ordinary message");
    expect(report).toContain("Data folder: ~/data");
    expect(report).toContain("~/project");
  });
});

test("doctor, report and plugin list send local requests directly, never to an environment proxy", async () => {
  await withPlugin(async (_, root) => {
    const data = join(root, "data");
    await mkdir(data);
    const token = "ad".repeat(32);
    const invite = "ce".repeat(32);
    const received = [];
    const intercepted = [];
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        intercepted.push(request.url);
        return new Response("unexpected proxy request", { status: 502 });
      },
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${token}`)
          return new Response("", { status: 401 });
        const path = new URL(request.url).pathname;
        received.push(path);
        return Response.json(
          path === "/health"
            ? identity
            : {
                plugins: [{ plugin: { id: invite, version: "0.1.0", token }, fromIndex: true }],
              },
        );
      },
    });
    const identity = {
      pid: process.pid,
      url: `ws://127.0.0.1:${server.port}/ws`,
      bundleHash: "a".repeat(64),
      buildId: "b".repeat(64),
    };
    const address = `http://127.0.0.1:${proxy.port}`;
    const discovery = join(data, "server.json");
    const env = {
      ...process.env,
      TOKAMAK_SERVER_DIR: data,
      TOKAMAK_SERVER: undefined,
      TOKAMAK_TOKEN: undefined,
      HTTP_PROXY: address,
      http_proxy: address,
      HTTPS_PROXY: address,
      https_proxy: address,
      ALL_PROXY: address,
      all_proxy: address,
      NO_PROXY: "example.invalid",
      no_proxy: "example.invalid",
    };
    async function run(args) {
      const child = Bun.spawn(
        [process.execPath, join(workspace, "packages/cli/src/main.ts"), ...args, "--json"],
        {
          cwd: root,
          env,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, stderr, value: JSON.parse(stdout) };
    }
    try {
      await writeFile(join(data, "server.token"), token, { mode: 0o600 });
      await writeFile(discovery, JSON.stringify({ ...identity, pid: 2147483647 }));
      const stale = await run(["doctor"]);
      expect(stale.value.rows.at(-1).state).toBe("not ready");
      expect(received).toEqual([]);
      expect(intercepted).toEqual([]);
      await writeFile(discovery, JSON.stringify(identity));
      const doctor = await run(["doctor"]);
      expect(doctor.value.rows.at(-1).state).toBe("ready");
      expect((await run(["plugin", "list"])).code).toBe(0);
      const report = await run(["report"]);
      expect(report.code, report.stderr).toBe(0);
      const contents = await readFile(report.value.path, "utf8");
      expect(contents.includes(invite)).toBe(false);
      expect(contents.includes(token)).toBe(false);
      expect(received).toEqual(["/health", "/health", "/plugins", "/health", "/plugins"]);
      expect(intercepted).toEqual([]);
    } finally {
      server.stop(true);
      proxy.stop(true);
    }
  });
}, 90_000);

test("help and report load with missing TypeScript and doctor runs an actual compiler program", async () => {
  await withPlugin(async (_, root) => {
    const checkout = join(root, "checkout");
    await mkdir(join(checkout, "packages/build"), { recursive: true });
    await cp(join(workspace, "packages/cli/src"), join(checkout, "packages/cli/src"), { recursive: true });
    await cp(join(workspace, "packages/cli/package.json"), join(checkout, "packages/cli/package.json"));
    await cp(join(workspace, "packages/tokamak-version.ts"), join(checkout, "packages/tokamak-version.ts"));
    await cp(join(workspace, "packages/build/src"), join(checkout, "packages/build/src"), {
      recursive: true,
    });
    await cp(join(workspace, "packages/sdk/tools"), join(checkout, "packages/sdk/tools"), {
      recursive: true,
    });
    await cp(join(workspace, "packages/runtime/tools"), join(checkout, "packages/runtime/tools"), {
      recursive: true,
    });
    await cp(join(workspace, ".prototools"), join(checkout, ".prototools"));
    const main = join(checkout, "packages/cli/src/main.ts");
    const run = (args) =>
      Bun.spawnSync([process.execPath, main, ...args, "--json"], {
        cwd: root,
        env: { ...process.env, TOKAMAK_SERVER_DIR: join(root, "data") },
        stdout: "pipe",
        stderr: "pipe",
      });
    const parse = (result) => {
      const stdout = result.stdout.toString();
      expect(stdout.length, result.stderr.toString()).toBeGreaterThan(0);
      return JSON.parse(stdout);
    };
    expect(parse(run(["--help"])).ok).toBe(true);
    expect(parse(run(["report", "--out", "missing-tools.md"])).ok).toBe(true);
    expect(parse(run(["doctor"])).rows[3].state).toBe("not ready");

    const typescript = join(checkout, "packages/build/node_modules/typescript");
    await mkdir(typescript, { recursive: true });
    await writeFile(join(typescript, "package.json"), '{"main":"index.cjs"}');
    await writeFile(
      join(typescript, "index.cjs"),
      'exports.createProgram = () => { throw new Error("FakeBrokenTypeScript"); };',
    );
    const broken = parse(run(["doctor"])).rows[3];
    expect(broken.state).toBe("not ready");
    expect(broken.detail).toContain("FakeBrokenTypeScript");
    expect(broken.fix).toBe("proto run bun -- install --frozen-lockfile --force");
    await writeFile(join(checkout, ".prototools"), "");
    expect(parse(run(["doctor"])).rows[1]).toMatchObject({
      state: "not ready",
      detail: expect.stringContaining("pin is missing"),
      fix: "git restore -- .prototools",
    });
  });
}, 90_000);

test("report bounds a long log tail and opens the destination before collecting diagnostics", async () => {
  await withPlugin(async (_, root) => {
    const data = join(root, "data");
    await mkdir(data);
    const line = "2040-01-02T03:04:05Z WARN server: ";
    await writeFile(join(data, "server.log"), line + "x".repeat(2 * 1024 * 1024));
    const result = diagnosticCli(root, ["report", "--out", "long-line.md", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const text = await readFile(JSON.parse(result.stdout).path, "utf8");
    expect(text).toContain("Log tail limited to the last 1 MiB.");
    expect(text).not.toContain(line);
    expect(text.length).toBeLessThan(4096);

    const marker = join(root, "collected");
    const preload = join(root, "collection.mjs");
    await writeFile(
      preload,
      `
      import { writeFileSync } from "node:fs";
      const running = process.versions.bun;
      Object.defineProperty(process.versions, "bun", { get() {
        writeFileSync(${JSON.stringify(marker)}, "collected");
        return running;
      } });
    `,
    );
    const unavailable = diagnosticCli(
      root,
      ["report", "--out", "missing-parent/report.md", "--json"],
      {},
      root,
      ["--preload", preload],
    );
    expect(unavailable.code).toBe(1);
    expect(JSON.parse(unavailable.stdout).error.message).toContain("writable");
    expect(await Bun.file(marker).exists()).toBe(false);
    const usable = diagnosticCli(root, ["report", "--out", "valid.md"], {}, root, ["--preload", preload]);
    expect(usable.code, usable.stderr).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(true);
  });
}, 45_000);

test("reports created at the same instant reserve distinct default names", async () => {
  await withPlugin(async (_, root) => {
    const clock = join(root, "clock.mjs");
    await writeFile(
      clock,
      `
      const RealDate = Date;
      globalThis.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : ["2040-01-02T03:04:05.678Z"])); }
      };
    `,
    );
    const paths = [];
    for (let i = 0; i < 2; i++) {
      const report = diagnosticCli(root, ["report", "--json"], {}, root, ["--preload", clock]);
      expect(report.code, report.stderr).toBe(0);
      paths.push(JSON.parse(report.stdout).path);
    }
    expect(paths[0]).toBe(join(root, "tokamak-report-2040-01-02T03-04-05.678Z.md"));
    expect(paths[1]).toMatch(/tokamak-report-2040-01-02T03-04-05\.678Z-[a-f0-9]{8}\.md$/);
    expect(await readFile(paths[0], "utf8")).toContain("# Tokamak diagnostic report");
    expect(await readFile(paths[1], "utf8")).toContain("# Tokamak diagnostic report");
  });
}, 45_000);

test("doctor reports ready after running its local server fix", async () => {
  await withPlugin(async (_, root) => {
    const installed = join(root, "installed");
    await mkdir(installed);
    const env = { TOKAMAK_PLUGIN_DIR: installed };
    const run = (...args) => diagnosticCli(root, [...args, "--json"], env);
    const initial = run("doctor");
    expect(initial.code, initial.stderr).toBe(1);
    const row = JSON.parse(initial.stdout).rows.find(({ name }) => name === "Local server");
    expect(row).toMatchObject({ state: "not ready", fix: "tokamak server start" });
    try {
      const started = run(...row.fix.split(" ").slice(1));
      expect(started.code, started.stderr).toBe(0);
      const identity = JSON.parse(started.stdout);
      const fixed = run("doctor");
      expect(fixed.code, fixed.stderr).toBe(0);
      expect(JSON.parse(fixed.stdout).rows.find(({ name }) => name === "Local server")).toEqual({
        name: "Local server",
        state: "ready",
        detail: `${identity.address} · build id ${identity.buildId}`,
      });
    } finally {
      const stopped = run("server", "stop");
      expect(stopped.code, stopped.stderr).toBe(0);
    }
  });
}, 120_000);
