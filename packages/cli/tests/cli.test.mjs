import { expect, test } from "bun:test";
import { chmod, cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { withPlugin, workspace } from "../../build/tests/outside-fixture.mjs";
import { createApi, TokamakClient, WebSocketTransport } from "../../sdk/src/index";
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
      expect.arrayContaining(["plugin build", "plugin add", "plugin remove", "plugin list", "plugin reload"]),
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

async function withServer(root, check, { killed = false } = {}) {
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
    env: { ...process.env, TOKAMAK_WEB_DIR: undefined },
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

test("reload applies index additions and removals without a restart", async () => {
  await withPlugin(async (plugin, root) => {
    const run = (...args) => {
      const result = cli(root, ["plugin", ...args, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    await withServer(root, async () => {
      run("add", plugin);
      expect(run("reload", "outside-fixture")).toMatchObject({
        plugins: [
          { id: "outside-fixture", status: "loaded", buildId: expect.stringMatching(/^[a-f0-9]{64}$/) },
        ],
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
