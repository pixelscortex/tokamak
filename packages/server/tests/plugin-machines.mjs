import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, connect, watchQuery, within, workspace } from "../../../e2e/fake-agent/harness.mjs";
import { authCaller } from "../../sdk/src/index.ts";

const [server, runner] = process.argv.slice(2);
const scratch = await mkdtemp(join(tmpdir(), "tokamak-plugin-machines-"));
const plugins = join(scratch, "plugins");
const ownerKey = "plugin-machine-test-owner-bootstrap-key";
const aliceKey = randomBytes(32).toString("hex");
const publicUrl = "https://workspace.example.test";
const cleanup = [];
let serverProcess;
const runners = [];
const serverLogs = [];
let serverStderr;
const failure = (kind) => ({ failed: true, kind, data: null });

async function install(name, id) {
  const source = join(scratch, name);
  await cp(join(import.meta.dir, "fixtures/plugin-machines", name), source, { recursive: true });
  await symlink(join(workspace, "app/node_modules"), join(source, "node_modules"), "dir");
  await writeFile(
    join(source, "tsconfig.json"),
    JSON.stringify({
      extends: join(workspace, "tsconfig.json"),
      compilerOptions: { types: ["node"] },
    }),
  );
  build(source);
  await cp(join(source, "dist"), join(plugins, id), { recursive: true });
  return (await import(join(source, "src/_generated/api.ts"))).api.work;
}

function startMachine(http, keyFile) {
  const child = Bun.spawn(
    [
      runner,
      "--server",
      http.href,
      "--key-file",
      keyFile,
      "--plugins",
      plugins,
      "--data",
      join(scratch, "runner-data"),
    ],
    {
      env: {
        ...process.env,
        ...(process.env.TOKAMAK_TEST_RUNNER_HOST && {
          TOKAMAK_PLUGIN_HOST: process.env.TOKAMAK_TEST_RUNNER_HOST,
        }),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const logs = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  runners.push({ child, logs });
  return { child, logs };
}

async function until(read, predicate, label) {
  const end = performance.now() + 5000;
  do {
    const result = await read();
    if (predicate(result)) return result;
    await Bun.sleep(20);
  } while (performance.now() < end);
  assert.fail(`Timed out: ${label}`);
}

try {
  await mkdir(plugins);
  const other = await install("outsider", "machine-outsider");
  const own = await install("sandbox", "sandbox-test");
  const dir = join(scratch, "server");
  await mkdir(dir);
  await writeFile(join(dir, "index.html"), "Plugin machine test");
  // Exercise the legacy device id retained for migrated members.
  await writeFile(
    join(dir, "members.json"),
    JSON.stringify([
      {
        id: "alice",
        name: "Alice",
        role: "member",
        created_at: 1,
        token_hash: createHash("sha256").update(aliceKey).digest("hex"),
      },
    ]),
    { mode: 0o600 },
  );
  serverProcess = Bun.spawn(
    [server, "--plugins", plugins, "--data", join(dir, "store"), "--listen", "127.0.0.1:0", "--web", dir],
    {
      env: { ...process.env, TOKAMAK_ACCESS_TOKEN: ownerKey, TOKAMAK_PUBLIC_URL: publicUrl },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  serverStderr = new Response(serverProcess.stderr).text();
  const lines = createInterface({ input: Readable.fromWeb(serverProcess.stdout) });
  cleanup.push(() => lines.close());
  const address = await within(
    new Promise((resolve, reject) => {
      lines.on("line", (line) => {
        serverLogs.push(line);
        const match = line.match(/ws:\/\/127\.0\.0\.1:\d+\/ws/);
        if (match) resolve(match[0]);
      });
      lines.once("close", () => reject(new Error("Server exited before readiness")));
    }),
    "server readiness",
  );
  const http = new URL(address);
  http.protocol = "http:";
  http.pathname = "/";
  async function issueOwnerDevice() {
    const response = await fetch(new URL("/auth/owner", http), {
      method: "POST",
      headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
      body: JSON.stringify({ deviceName: "Owner window" }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).key;
  }

  const ownerDeviceKey = await issueOwnerDevice();
  const window = await connect(address, {
    token: ownerDeviceKey,
    cleanup,
    launch() {
      throw new Error("An explicit id never uses the window Runner");
    },
  });
  const alice = await connect(address, { token: aliceKey, cleanup });

  const created = await window.action(own.create, { name: "Sandbox" });
  const { id, key } = created;
  assert.match(id, /^machine:/);
  assert.equal(created.server, publicUrl);
  const store = join(dir, "plugin-machines.json");
  const persisted = JSON.parse(await readFile(store, "utf8"));
  assert.equal(persisted[0].key_hash, createHash("sha256").update(key).digest("hex"));
  assert.ok(!JSON.stringify(persisted).includes(key));
  const keyFile = join(scratch, "machine.key");
  await writeFile(keyFile, key + "\n", { mode: 0o600 });

  const readOwn = async () => (await window.query(own.list, {})).find((entry) => entry.id === id);
  assert.deepEqual(await readOwn(), {
    id,
    name: "Sandbox",
    owner: { kind: "plugin", plugin: "sandbox-test" },
    online: false,
    lastSeen: null,
  });
  const offline = failure("machineOffline");
  const forbidden = failure("machineForbidden");
  assert.deepEqual(
    await within(window.action(own.interrupted, {}, { on: id }), "offline action fails promptly", 2000),
    offline,
  );
  assert.deepEqual(await window.action(own.waitOnline, { id, timeoutMs: 25 }), offline);

  const waiting = window.action(own.waitOnline, { id, timeoutMs: 5000 });
  const { child } = startMachine(http, keyFile);
  assert.equal(await within(waiting, "wait for plugin machine"), null);
  assert.equal(await window.action(own.waitOnline, { id, timeoutMs: 0 }), null);
  assert.ok((await readOwn()).lastSeen);
  assert.equal((await readOwn()).online, true);
  assert.equal(
    (await window.query(other.list, {})).some((entry) => entry.id === id),
    false,
  );
  assert.deepEqual(await window.action(other.where, {}, { on: id }), forbidden);
  assert.deepEqual(await window.action(own.delegateOther, { id }), { runner: true });
  assert.deepEqual(await window.action(other.where, {}, { on: "device:alice" }), forbidden);

  const account = await fetch(new URL("/account", http), { headers: { authorization: `Bearer ${key}` } });
  assert.equal(account.status, 401);
  const memberSnapshot = await fetch(new URL("/devices/machines/live", http), {
    headers: { authorization: `Bearer ${aliceKey}` },
  });
  assert.equal(memberSnapshot.status, 403);

  const snapshot = await fetch(new URL("/devices/machines/live", http), {
    headers: { authorization: `Bearer ${ownerDeviceKey}` },
  });
  assert.equal(snapshot.status, 200);
  const reader = snapshot.body.getReader();
  let line = "";
  try {
    while (!line.includes("\n\n")) {
      const { done, value } = await within(reader.read(), "plugin machines snapshot");
      assert.equal(done, false);
      line += new TextDecoder().decode(value);
    }
  } finally {
    await reader.cancel();
  }
  const [entry] = JSON.parse(line.split("\n")[0].slice(6));
  assert.deepEqual(entry, {
    ...(await readOwn()),
    owner: { kind: "plugin", plugin: "sandbox-test", name: "Test sandbox" },
  });

  const file = join(scratch, "input");
  await writeFile(file, "sandbox machine file");
  const args = { file, thread: "chat/threads:sandbox" };
  const caller = await window.query(authCaller, {});
  for (const [depth, result] of [
    [0, await window.action(own.run, args, { on: id })],
    [1, await window.action(own.delegate, { ...args, id })],
  ]) {
    assert.deepEqual(result.output, ["from the Runner"]);
    assert.equal(result.status, 0);
    assert.equal(result.row.text, "sandbox machine file");
    const note = { ...caller, threadId: args.thread, depth };
    assert.deepEqual(result.auth, caller);
    assert.deepEqual(result.call, note);
    assert.deepEqual(result.queryCall, { ...note, depth: depth + 1 });
  }

  const watched = watchQuery(window, own.rows, {}, cleanup);
  const interrupted = window.action(own.interrupted, {}, { on: id });
  void interrupted.catch(() => {});
  await watched.until("start an action on the plugin machine", ({ rows }) =>
    rows.some(({ text }) => text === "waiting"),
  );
  child.kill("SIGKILL");
  await child.exited;
  assert.deepEqual(await within(interrupted, "lose the plugin machine"), failure("machineLost"));
  assert.ok((await until(readOwn, (entry) => entry?.online === false, "machine went offline")).lastSeen);
  assert.deepEqual(
    await within(window.action(own.interrupted, {}, { on: id }), "offline action fails promptly", 2000),
    offline,
  );

  const replacement = startMachine(http, keyFile);
  assert.equal(await window.action(own.waitOnline, { id, timeoutMs: 5000 }), null);
  assert.equal(await window.action(own.remove, { id }), null);
  assert.notEqual(await within(replacement.child.exited, "revocation closes live Runner"), 0);
  assert.equal(await readOwn(), undefined);
  assert.deepEqual(await window.action(own.interrupted, {}, { on: id }), forbidden);
  assert.equal(JSON.parse(await readFile(store, "utf8"))[0].key_hash, null);
  const refused = startMachine(http, keyFile);
  assert.notEqual(await within(refused.child.exited, "refuse removed key"), 0);
  assert.match((await refused.logs).join(""), /invalid or revoked/i);

  const aliceFile = join(scratch, "alice.key");
  await writeFile(aliceFile, aliceKey + "\n", { mode: 0o600 });
  const personal = startMachine(http, aliceFile);
  assert.equal(await alice.action(own.waitOnline, { id: "device:alice", timeoutMs: 5000 }), null);
  assert.deepEqual(await window.action(own.personalDefault, {}), forbidden);
  assert.deepEqual(await window.action(other.where, {}, { on: "device:alice" }), forbidden);
  const aliceCaller = await alice.query(authCaller, {});
  assert.deepEqual(await alice.action(own.personalDefault, {}), {
    runner: true,
    call: { ...aliceCaller, depth: 0 },
  });
  personal.child.kill();
  await personal.child.exited;

  serverProcess.kill();
  await serverProcess.exited;
  assert.ok(!(serverLogs.join("") + (await serverStderr)).includes(key));
  for (const { logs } of runners) assert.ok(!(await logs).join("").includes(key));
} finally {
  for (const { child } of runners) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  for (const close of cleanup.reverse()) await close();
  if (serverProcess?.exitCode === null) serverProcess.kill();
  await serverProcess?.exited;
}
