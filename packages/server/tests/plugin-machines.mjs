import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, connect, watchQuery, within, workspace } from "../../../e2e/fake-agent/harness.mjs";
import { authCaller, WebSocketTransport } from "../../sdk/src/index.ts";

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
const serverStderr = [];
const failure = (kind) => ({ failed: true, kind, data: null });

async function install(name, id) {
  const source = join(scratch, name === "sandbox" ? id : name);
  await cp(join(import.meta.dir, "fixtures/plugin-machines", name), source, { recursive: true });
  await symlink(join(workspace, "app/node_modules"), join(source, "node_modules"), "dir");
  await writeFile(
    join(source, "tsconfig.json"),
    JSON.stringify({
      extends: join(workspace, "tsconfig.json"),
      compilerOptions: { types: ["node"] },
    }),
  );
  if (name === "provider") {
    await mkdir(join(source, "contracts"));
    await cp(join(scratch, "outsider/src/contracts.ts"), join(source, "contracts/machine-outsider.ts"));
  }
  build(source);
  await cp(join(source, "dist"), join(plugins, id), { recursive: true });
  if (name === "outsider" || name === "sandbox")
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

async function startServer(dir, source = ["--plugins", plugins]) {
  serverProcess = Bun.spawn(
    [server, ...source, "--data", join(dir, "store"), "--listen", "127.0.0.1:0", "--web", dir],
    {
      env: { ...process.env, TOKAMAK_ACCESS_TOKEN: ownerKey, TOKAMAK_PUBLIC_URL: publicUrl },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  serverStderr.push(new Response(serverProcess.stderr).text());
  const lines = createInterface({ input: Readable.fromWeb(serverProcess.stdout) });
  cleanup.push(() => lines.close());
  return within(
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
}

function httpAddress(address) {
  const http = new URL(address);
  http.protocol = "http:";
  http.pathname = "/";
  return http;
}

async function stopServer() {
  serverProcess.kill();
  await within(serverProcess.exited, "server shutdown");
}

async function reloadPlugin(http, id) {
  const response = await fetch(new URL(`/plugins/${id}/reload`, http), {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}` },
  });
  assert.equal(response.status, 200, await response.text());
}

async function anonymousCall(http, id) {
  const response = await fetch(new URL("/auth/sign-in", http), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "machine-probe", deviceName: "Probe", fields: { id } }),
  });
  assert.equal(response.status, 401);
  return response.json();
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
  await install("provider", "machine-provider");
  await install("hooks", "machine-hooks");
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
  const address = await startServer(dir);
  const http = httpAddress(address);
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

  const caller = await window.query(authCaller, {});
  const created = await window.action(own.create, { name: "Sandbox", member: caller.user.id });
  const { id, key } = created;
  assert.match(id, /^machine:/);
  assert.equal(created.server, publicUrl);
  const store = join(dir, "plugin-machines.json");
  const persisted = JSON.parse(await readFile(store, "utf8"));
  assert.equal(persisted[0].key_hash, createHash("sha256").update(key).digest("hex"));
  assert.ok(!JSON.stringify(persisted).includes(key));
  const keyFile = join(scratch, "machine.key");
  assert.deepEqual(
    await window.action(own.create, { name: "Invalid member", member: "missing" }),
    failure("machineForbidden"),
  );
  await writeFile(keyFile, key + "\n", { mode: 0o600 });

  const readOwn = async () => (await window.query(own.list, {})).find((entry) => entry.id === id);
  assert.deepEqual(await readOwn(), {
    id,
    name: "Sandbox",
    member: caller.user.id,
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
  const hookUnavailable = { kind: "hookRunnerUnavailable", plugin: "machine-hooks" };
  const beforeHooks = (await window.query(own.rows, {})).rows;
  await assert.rejects(window.action(own.hookedAction, {}, { on: id }), {
    ...hookUnavailable,
    stage: "before",
    hook: "policy:action",
  });
  await assert.rejects(window.action(own.hookedPoint, {}, { on: id }), {
    ...hookUnavailable,
    stage: "pointBefore",
    point: "gate",
  });
  assert.deepEqual((await window.query(own.rows, {})).rows, beforeHooks);
  assert.deepEqual(await window.action(other.where, {}, { on: id }), forbidden);
  assert.deepEqual(await window.action(own.delegateOther, { id }), forbidden);
  assert.deepEqual(await alice.action(own.interrupted, {}, { on: id }), forbidden);
  assert.equal(
    (await alice.query(own.list, {})).some((entry) => entry.id === id),
    false,
  );
  assert.deepEqual(await window.action(other.where, {}, { on: "device:alice" }), forbidden);

  assert.deepEqual(await anonymousCall(http, id), forbidden);
  assert.ok((await window.action(own.listAll, {})).some((entry) => entry.id === id));
  assert.deepEqual(
    await alice.action(own.delegate, { id, file: "not read", thread: "chat/threads:fixture" }),
    forbidden,
  );
  for (const operation of ["create", "remove", "waitOnline", "listAll", "url"]) {
    assert.deepEqual(await window.action(own.management, { operation, id }, { on: id }), {
      failed: true,
      kind: "serverOnly",
      data: { message: "Machine management and the server address are only available beside the server" },
    });
  }

  const socket = new WebSocket(address, ["tokamak", `tokamak.bearer.${ownerDeviceKey}`]);
  await within(
    new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    }),
    "connect window action transport",
  );
  const bridge = new WebSocketTransport(socket);
  cleanup.push(() => bridge.close());
  const local = await bridge.dispatchWindowAction("sandbox-test/work:interrupted", {});
  assert.equal(local.destination, "callerWindowRunner");
  const localList = (plugin) =>
    bridge.continueLocalCall("query", "tokamak:callerMachines", { plugin }, local.note);
  assert.ok((await localList("sandbox-test")).some((entry) => entry.id === id));
  await assert.rejects(localList("machine-outsider"), /matching window action continuation/);
  bridge.finishWindowAction(local.requestId);

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
    member: { id: caller.user.id, name: caller.user.name },
  });

  const file = join(scratch, "input");
  await writeFile(file, "sandbox machine file");
  const args = { file, thread: "chat/threads:sandbox" };
  for (const [depth, result] of [
    [0, await window.action(own.run, args, { on: id })],
    [1, await window.action(own.delegate, { ...args, id })],
  ]) {
    assert.ok(result.machines.some((entry) => entry.id === id));
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
  const revoking = window.action(own.interrupted, { marker: "revoking" }, { on: id });
  void revoking.catch(() => {});
  await watched.until("start action before revoking its machine", ({ rows }) =>
    rows.some(({ text }) => text === "revoking"),
  );
  assert.equal(await window.action(own.remove, { id }), null);
  assert.deepEqual(await within(revoking, "lose the revoked machine"), failure("machineLost"));
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
  assert.equal(await alice.action(other.outsideProvider, {}, { on: "device:alice" }), "provider");
  const contractMachine = await window.action(other.create, {});
  const contractKey = join(scratch, "contract.key");
  await writeFile(contractKey, contractMachine.key + "\n", { mode: 0o600 });
  startMachine(http, contractKey);
  assert.equal(await window.action(other.waitOnline, { id: contractMachine.id }), null);
  await assert.rejects(
    window.action(other.outsideProvider, {}, { on: contractMachine.id }),
    /Contract provider machine-provider has no read method/,
  );
  assert.equal(await window.action(other.remove, { id: contractMachine.id }), null);
  personal.child.kill();
  await personal.child.exited;

  const unbound = await window.action(own.create, { name: "Server sandbox" });
  assert.equal(await window.action(own.unboundCount, {}), 1);
  assert.equal(
    (await window.query(own.list, {})).some((entry) => entry.id === unbound.id),
    false,
  );
  assert.equal(
    (await alice.query(own.list, {})).some((entry) => entry.id === unbound.id),
    false,
  );
  const unboundFile = join(scratch, "unbound.key");
  await writeFile(unboundFile, unbound.key + "\n", { mode: 0o600 });
  const unboundRunner = startMachine(http, unboundFile);
  assert.equal(await window.action(own.waitOnline, { id: unbound.id, timeoutMs: 5000 }), null);
  assert.deepEqual(await window.action(own.run, args, { on: unbound.id }), forbidden);
  assert.deepEqual(await window.action(own.delegateOther, { id: unbound.id }), forbidden);
  const serverCall = await window.action(own.delegate, { ...args, id: unbound.id });
  assert.equal(serverCall.status, 0);

  assert.deepEqual(await anonymousCall(http, unbound.id), failure("AnonymousRunner"));

  const pending = window.action(own.createAfterReload, {});
  await until(
    () => window.query(own.rows, {}),
    ({ rows }) => rows.some(({ text }) => text === "ready to reload"),
    "server action entered before reload",
  );
  await reloadPlugin(http, "machine-outsider");
  await window.mutation(own.store, { text: "reload finished" });
  const duringReload = await within(pending, "create after unrelated reload");
  assert.match(duringReload.id, /^machine:/);
  assert.equal(await window.action(own.remove, { id: duringReload.id }), null);

  const installed = join(plugins, "sandbox-test");
  const removed = join(scratch, "removed-sandbox");
  const assertKeyRetained = async () => {
    const entry = JSON.parse(await readFile(store, "utf8")).find((record) => record.id === unbound.id);
    assert.equal(entry.key_hash, createHash("sha256").update(unbound.key).digest("hex"));
  };
  await stopServer();
  unboundRunner.child.kill();
  await unboundRunner.child.exited;

  await startServer(dir, ["--bundle", join(scratch, "outsider/dist/bundle.js")]);
  await assertKeyRetained();
  await stopServer();

  await rename(installed, removed);
  await cp(removed, installed, { recursive: true });
  const transactions = join(installed, "transactions.js");
  const broken =
    (await readFile(transactions, "utf8")) + '\nthrow new Error("fixture plugin load failure");\n';
  await writeFile(transactions, broken);
  const manifestPath = join(installed, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.hashes["transactions.js"] = createHash("sha256").update(broken).digest("hex");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const skippedAddress = await startServer(dir);
  await assertKeyRetained();
  await reloadPlugin(httpAddress(skippedAddress), "machine-outsider");
  await assertKeyRetained();
  await stopServer();
  assert.match(
    (await Promise.all(serverStderr)).join(""),
    /Skipping plugin sandbox-test: .*fixture plugin load failure/,
  );

  await rename(installed, join(scratch, "failed-sandbox"));
  await rename(removed, installed);
  const recoveredAddress = await startServer(dir);
  const recoveredHttp = httpAddress(recoveredAddress);
  const recovered = await connect(recoveredAddress, { token: ownerDeviceKey, cleanup });
  const recoveredRunner = startMachine(recoveredHttp, unboundFile);
  assert.equal(await recovered.action(own.waitOnline, { id: unbound.id, timeoutMs: 5000 }), null);

  await rename(installed, removed);
  await reloadPlugin(recoveredHttp, "sandbox-test");
  assert.notEqual(await within(recoveredRunner.child.exited, "uninstall revokes live Runner"), 0);
  const revoked = JSON.parse(await readFile(store, "utf8")).find((entry) => entry.id === unbound.id);
  assert.equal(revoked.key_hash, null);
  assert.ok(revoked.removed_at);
  await rename(removed, installed);
  await reloadPlugin(recoveredHttp, "sandbox-test");
  const afterReinstall = startMachine(recoveredHttp, unboundFile);
  assert.notEqual(await within(afterReinstall.child.exited, "reinstall cannot reuse the old key"), 0);
  assert.match((await afterReinstall.logs).join(""), /invalid or revoked/i);
  assert.deepEqual(await recovered.action(own.delegate, { ...args, id: unbound.id }), forbidden);

  await stopServer();
  assert.ok(!(serverLogs.join("") + (await Promise.all(serverStderr)).join("")).includes(key));
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
