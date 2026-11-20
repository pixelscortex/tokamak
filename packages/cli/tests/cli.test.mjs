import { expect, test } from "bun:test";
import { chmod, cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, toNamespacedPath } from "node:path";
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

test("the server executable rejects all people subcommands", async () => {
  await withPlugin((_, root) => {
    for (const command of ["invite", "members", "revoke"]) {
      const result = Bun.spawnSync([serverBinary(), command, "unused"], { cwd: root });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(`unknown option ${command}`);
    }
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
