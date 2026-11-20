import { expect, test } from "bun:test";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createApi, TokamakClient, WebSocketTransport } from "../../sdk/src/index";
import { withPlugin, workspace } from "../../build/tests/outside-fixture.mjs";

function cli(root, args, extra = {}) {
  const result = Bun.spawnSync([process.execPath, "run", "tokamak", ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      TOKAMAK_SERVER: undefined,
      TOKAMAK_TOKEN: undefined,
      TOKAMAK_SERVER_DIR: join(root, "data"),
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("builds an external plugin and reports its output folder", async () => {
  await withPlugin((plugin, root) => {
    const result = cli(root, ["plugin", "build", plugin, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      id: "outside-fixture",
      outputFolder: join(plugin, "dist"),
    });
  });
}, 30_000);

test("returns structured type errors in both checker formats", async () => {
  await withPlugin(async (plugin, root) => {
    await writeFile(join(plugin, "src/server/broken.ts"), "\nexport const broken: string = 42;\n");
    for (const AI_AGENT of [undefined, "1"]) {
      const result = cli(root, ["plugin", "build", plugin, "--json"], { AI_AGENT });
      expect(result.code).not.toBe(0);
      const { error } = JSON.parse(result.stdout);
      expect(error.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ file: expect.stringMatching(/broken\.ts$/), line: 2, code: "TS2322" }),
        ]),
      );
    }
  });
}, 30_000);

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
    expect(result.stdout).toContain("tokamak server start");
  });
});

test("every registered command shares help and JSON output rules", async () => {
  const { commands } = await import("../src/commands");
  await withPlugin((_, root) => {
    expect(commands.map(({ path }) => path)).toEqual(
      expect.arrayContaining(["plugin build", "plugin add", "plugin remove", "plugin list", "plugin reload"]),
    );
    for (const path of ["", "plugin", ...commands.map((command) => command.path)]) {
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
    for (const command of commands.filter(({ args }) => args && !args.optional)) {
      const missing = cli(root, [...command.path.split(" "), "--json"]);
      expect(missing.code).not.toBe(0);
      expect(JSON.parse(missing.stdout).error.message).toContain("Missing argument");
    }
    const unknown = cli(root, ["unknown-command", "--json"]);
    expect(unknown.code).not.toBe(0);
    expect(JSON.parse(unknown.stdout).error.next).toBe("tokamak --help");
  });
}, 30_000);

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
    env: { ...process.env, TOKAMAK_WEB_DIR: undefined },
    stdout: "ignore",
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
      run(["add", plugin]);
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
}, 180_000);

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
    await withServer(root, () => {
      run("add", plugin);
      expect(run("reload", "outside-fixture")).toMatchObject({
        plugins: [{ id: "outside-fixture", status: "loaded" }],
      });
      expect(run("list").plugins).toEqual([{ id: "outside-fixture", version: "0.1.0", fromIndex: true }]);
      run("remove", "outside-fixture");
      expect(run("reload").plugins).toEqual([]);
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
        expect(run("reload", "outside-fixture")).toEqual({
          ok: true,
          plugins: [{ id: "outside-fixture", status: "loaded" }],
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
