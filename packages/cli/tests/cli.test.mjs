import { expect, test } from "bun:test";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
    await cp(join(workspace, "packages/build/src"), join(checkout, "packages/build/src"), {
      recursive: true,
    });
    await cp(join(workspace, "packages/sdk/tools"), join(checkout, "packages/sdk/tools"), {
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
