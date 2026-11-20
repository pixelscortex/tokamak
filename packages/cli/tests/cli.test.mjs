import { expect, test } from "bun:test";
import { chmod, cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, toNamespacedPath } from "node:path";
import { randomBytes } from "node:crypto";
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
      expect.arrayContaining([
        "plugin build",
        "plugin add",
        "plugin remove",
        "plugin list",
        "invite",
        "members",
        "revoke",
        "server start",
        "server stop",
        "server status",
      ]),
    );
    for (const path of ["", "plugin", "server", ...commands.map((command) => command.path)]) {
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

function serverBinary() {
  const target = resolve(workspace, process.env.CARGO_TARGET_DIR ?? "target");
  return join(target, "debug", process.platform === "win32" ? "tokamak-server.exe" : "tokamak-server");
}

async function withServer(root, check) {
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
    env: { ...process.env, TOKAMAK_WEB_DIR: undefined },
    stdout: "ignore",
    stderr: "pipe",
  });
  let address;
  const serverErrors = new Response(server.stderr).text();
  try {
    const deadline = Date.now() + 35_000;
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
      const connects = () =>
        new Promise((resolve) => {
          const socket = new WebSocket(`${address.replace(/^http:/, "ws:")}/ws`, {
            headers: { authorization: `Bearer ${invite}` },
          });
          const timeout = setTimeout(() => {
            socket.close();
            resolve(false);
          }, 5000);
          socket.addEventListener("open", () => {
            clearTimeout(timeout);
            socket.close();
            resolve(true);
          });
          socket.addEventListener("error", () => {
            clearTimeout(timeout);
            resolve(false);
          });
        });
      expect(await connects()).toBe(true);
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
      const revoked = cli(root, ["revoke", alice.id, "--json"], owner);
      expect(revoked.code, JSON.parse(revoked.stdout).error?.message).toBe(0);
      expect(JSON.parse(revoked.stdout)).toEqual({ ok: true, revoked: alice.id });
      expect(await connects()).toBe(false);
      const remaining = cli(root, ["members", "--json"]);
      expect(remaining.code).toBe(0);
      expect(JSON.parse(remaining.stdout).members.some(({ id }) => id === alice.id)).toBe(false);
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
      expect(run("status")).toEqual({ ok: true, running: true, address, pid, buildId });

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

test("the server executable rejects invite and members", async () => {
  await withPlugin((_, root) => {
    for (const command of ["invite", "members"]) {
      const result = Bun.spawnSync([serverBinary(), command, "unused"], { cwd: root });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(`unknown option ${command}`);
    }
  });
});
