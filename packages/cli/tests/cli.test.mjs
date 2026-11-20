import { expect, test } from "bun:test";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { build, withPlugin, workspace } from "../../build/tests/outside-fixture.mjs";

function cli(root, args, extra = {}, cwd = workspace) {
  const entry = cwd === workspace ? "tokamak" : join(workspace, "packages/cli/src/main.ts");
  const result = Bun.spawnSync([process.execPath, "run", entry, ...args], {
    cwd,
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
    expect(result.stdout).toContain("tokamak server start");
  });
});

test("every registered command shares help and JSON output rules", async () => {
  const { commands } = await import("../src/commands");
  await withPlugin((_, root) => {
    expect(commands.map(({ path }) => path)).toEqual(
      expect.arrayContaining(["plugin build", "plugin add", "plugin remove", "plugin list"]),
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
}, 30_000);

async function withServer(root, check, startupTimeout = 35_000) {
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
    const deadline = Date.now() + startupTimeout;
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
}, 120_000);

test("open reports a missing folder and explains how to start a missing local server", async () => {
  await withPlugin((folder, root) => {
    const invalid = cli(root, ["open", join(root, "missing"), "--json"]);
    expect(invalid.code).not.toBe(0);
    expect(JSON.parse(invalid.stdout).error.message).toContain("Folder does not exist");
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
    await withServer(
      root,
      (address, token) => {
        const open = (args, cwd = workspace, env = {}) => {
          const result = cli(root, ["open", ...args, "--json"], env, cwd);
          expect(result.code, result.stderr).toBe(0);
          expect(result.stderr).toContain("exists. Opening Tokamak");
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
      },
      90_000,
    );
  });
}, 180_000);
