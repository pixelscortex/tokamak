import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  build,
  connect,
  startServer,
  watchQuery,
  within,
  workspace,
} from "../../../e2e/fake-agent/harness.mjs";
import { authCaller, WebSocketTransport } from "../../sdk/src/index.ts";

const [server, runner] = process.argv.slice(2);
const scratch = await mkdtemp(join(tmpdir(), "tokamak-connected-runner-"));
const cleanup = [];
const servers = [];
const runners = [];
const serverStdout = [];
let serverStderr;
const ownerKey = "connected-runner-test-owner-bootstrap-key";
const heartbeat = {
  TOKAMAK_MACHINE_HEARTBEAT_INTERVAL_MS: "200",
  TOKAMAK_MACHINE_HEARTBEAT_LIMIT_MS: "3000",
};
const noMachine = { failed: true, kind: "noMachine", data: null };
const machineLost = { failed: true, kind: "machineLost", data: null };

async function waitFor(check, label, ms = 5000) {
  const end = performance.now() + ms;
  do {
    const found = await check();
    if (found) return found;
    await Bun.sleep(20);
  } while (performance.now() < end);
  assert.fail(`timeout: ${label}`);
}

try {
  const source = join(scratch, "source");
  const plugins = join(scratch, "plugins");
  await cp(join(import.meta.dir, "fixtures/action-placement"), source, { recursive: true });
  await symlink(join(workspace, "app/node_modules"), join(source, "node_modules"), "dir");
  await writeFile(
    join(source, "tsconfig.json"),
    JSON.stringify({ extends: join(workspace, "tsconfig.json"), compilerOptions: { types: ["node"] } }),
  );
  build(source);
  await mkdir(plugins);
  await cp(join(source, "dist"), join(plugins, "ai"), { recursive: true });
  const { api } = await import(join(source, "src/_generated/api.ts"));
  const file = join(scratch, "input");
  await writeFile(file, "text from the connected Runner");

  const address = await startServer({
    binary: server,
    dir: join(scratch, "server"),
    pluginsDir: plugins,
    shared: true,
    ownerToken: ownerKey,
    servers,
    cleanup,
    env: { ...heartbeat, FIXTURE_ACTION_PLACEMENT: "on the server" },
    stdoutLine: (line) => serverStdout.push(line),
    stderr: "pipe",
    started(child) {
      serverStderr = new Response(child.stderr).text();
    },
  });
  const http = new URL(address);
  http.protocol = "http:";
  http.pathname = "/";
  const auth = (key) => ({ authorization: `Bearer ${key}` });
  async function issue(name) {
    const response = await fetch(new URL("/auth/owner", http), {
      method: "POST",
      headers: { ...auth(ownerKey), "content-type": "application/json" },
      body: JSON.stringify({ deviceName: name }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  const { device, key } = await issue("Headless test machine");
  const { key: browserKey } = await issue("Browser");
  const keyFile = join(scratch, "key");
  const wrongFile = join(scratch, "wrong-key");
  const wrongKey = "a9".repeat(32);
  await writeFile(keyFile, key + "\n", { mode: 0o600 });
  await writeFile(wrongFile, wrongKey + "\n", { mode: 0o600 });

  const links = [];
  const proxy = createServer((downstream) => {
    const upstream = createConnection({ host: "127.0.0.1", port: Number(http.port) });
    const link = { downstream, upstream, detached: false };
    links.push(link);
    downstream.pipe(upstream);
    upstream.pipe(downstream);
    downstream.on("error", () => {});
    upstream.on("error", () => {});
    downstream.on("close", () => {
      if (!link.detached) upstream.destroy();
    });
    upstream.on("close", () => downstream.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    for (const { upstream, downstream } of links) {
      upstream.destroy();
      downstream.destroy();
    }
    proxy.close();
  });
  const proxyAddress = `http://127.0.0.1:${proxy.address().port}`;

  function startMachine(path, origin = http.href) {
    const child = Bun.spawn(
      [
        runner,
        "--server",
        origin,
        "--key-file",
        path,
        "--data",
        join(scratch, "machine-data"),
        "--plugins",
        plugins,
      ],
      {
        env: {
          ...process.env,
          ...heartbeat,
          FIXTURE_ACTION_PLACEMENT: "on this machine",
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

  async function assertRefused(path, message) {
    const { child, logs } = startMachine(path);
    const status = await within(child.exited, `credential refusal ${message}`, 5000).catch(async (error) => {
      child.kill("SIGKILL");
      await child.exited;
      throw new Error(`${error.message}: ${(await logs).join("")}`);
    });
    assert.notEqual(status, 0);
    assert.match((await logs).join(""), message);
  }

  async function presence(expected, ms = 5000, deviceId = device.id) {
    return waitFor(
      async () => {
        const response = await fetch(new URL("/devices/live", http), {
          headers: auth(ownerKey),
          signal: AbortSignal.timeout(ms),
        });
        assert.equal(response.status, 200);
        const reader = response.body.getReader();
        let line = "";
        try {
          while (!line.includes("\n\n")) {
            const chunk = await reader.read();
            assert.equal(chunk.done, false, "Expected a device snapshot");
            line += new TextDecoder().decode(chunk.value);
          }
        } finally {
          await reader.cancel();
        }
        const entry = JSON.parse(line.split("\n")[0].slice(6)).find(({ id }) => id === deviceId);
        return entry?.online === expected && entry;
      },
      `machine online=${expected}`,
      ms,
    );
  }

  const browser = await connect(address, { token: browserKey, cleanup });
  const untrustedSocket = new WebSocket(address, ["tokamak", `tokamak.bearer.${browserKey}`]);
  await within(
    new Promise((resolve, reject) => {
      untrustedSocket.addEventListener("open", resolve, { once: true });
      untrustedSocket.addEventListener("error", reject, { once: true });
    }),
    "connect an ordinary window",
  );
  const untrusted = new WebSocketTransport(untrustedSocket);
  cleanup.push(() => untrusted.close());
  const forged = { depth: 3, thread: "chat/threads:forged" };
  const originalCaller = await browser.query(authCaller, {});
  const { call } = await untrusted.continueLocalCall("query", "ai/work:rows", {}, forged);
  assert.deepEqual(call, { ...originalCaller, depth: 0 });
  await assert.rejects(
    untrusted.continueLocalCall("query", "ai/work:rows", {}, { ...forged, proof: "forged" }),
    /unknown window action continuation/i,
  );
  const long = await untrusted.dispatchWindowAction("ai/work:callerDefault", {});
  assert.equal(long.destination, "callerWindowRunner");
  async function continueWindow() {
    return untrusted.continueLocalCall("query", "ai/work:rows", {}, long.note);
  }
  for (let index = 0; index < 200; index++) {
    const short = await untrusted.dispatchWindowAction("ai/work:callerDefault", {});
    assert.equal(short.destination, "callerWindowRunner");
  }
  assert.equal((await continueWindow()).call.depth, 1);
  untrusted.finishWindowAction(long.requestId);
  await assert.rejects(continueWindow(), /unknown window action continuation/i);

  const watched = watchQuery(browser, api.work.rows, {}, cleanup);
  assert.deepEqual(await browser.action(api.work.callerDefault, {}), noMachine);
  await assertRefused(wrongFile, /refused the device key/i);

  const { child: machine, logs: machineLogs } = startMachine(keyFile, proxyAddress);
  const ps = Bun.spawnSync(["ps", "-p", String(machine.pid), "-o", "args="]);
  const args = ps.stdout.toString();
  assert.ok(args.includes("--key-file"));
  assert.ok(!args.includes(key), "The persisted key is absent from process arguments");
  assert.ok((await presence(true)).lastSeen);

  let launches = 0;
  const window = await connect(address, {
    token: key,
    cleanup,
    launch() {
      launches++;
      throw new Error("This window cannot launch a local Runner");
    },
  });

  const code = join(plugins, "ai/local.js");
  const original = await readFile(code);
  try {
    await writeFile(code, "throw Error('tampered')\n");
    const failure = await window.action(api.work.callerDefault, {});
    assert.equal(failure.kind, "runnerArtifactMismatch");
    assert.match(failure.data.message, /hash mismatch/);
  } finally {
    await writeFile(code, original);
  }

  const identity = await window.query(authCaller, {});
  const argsWithThread = { file, thread: "chat/threads:connected" };
  const expected = (auth, depth) => ({
    verified: true,
    environment: "on this machine",
    auth,
    call: { ...auth, threadId: argsWithThread.thread, depth },
    queryCall: { ...auth, threadId: argsWithThread.thread, depth: depth + 1 },
    output: ["started"],
    saved: true,
    status: 0,
  });
  assert.deepEqual(await window.action(api.work.run, argsWithThread), expected(identity, 0));
  assert.equal(await window.action(api.work.callPrivate, {}), 1);
  assert.deepEqual(await window.action(api.delegate.program, argsWithThread), expected(identity, 1));
  assert.deepEqual(await browser.action(api.delegate.program, argsWithThread), noMachine);
  assert.deepEqual(await window.action(api.channel.stream, {}), {
    result: { sessionId: "fixture", stopped: true },
    received: ["started", "steered"],
  });
  assert.deepEqual(await window.action(api.provider.callServerContract, {}), { runner: true, depth: 1 });
  assert.equal(launches, 0);

  const other = await issue("Second machine");
  const otherKeyFile = join(scratch, "second-key");
  await writeFile(otherKeyFile, other.key + "\n", { mode: 0o600 });
  const second = startMachine(otherKeyFile);
  await presence(true, 5000, other.device.id);
  assert.deepEqual(await browser.action(api.delegate.choose, {}), noMachine);
  assert.deepEqual(await window.action(api.work.callerDefault, {}), { runner: true, depth: 0 });
  second.child.kill();
  await within(second.child.exited, "stop the second machine", 5000);
  await presence(false, 2000, other.device.id);

  async function startWaiting(signal) {
    const { rows: before } = await browser.query(api.work.rows, {});
    const action = window.action(api.work.connectedProgress, {}, { signal });
    // Progress arrives from the Runner while its action is still running.
    void action.catch(() => {});
    const { rows } = await watched.until(
      "receive running program output",
      ({ rows }) => rows.length === before.length + 3,
      5000,
    );
    const [pidText, first, second] = rows.slice(-3).map(({ text }) => text);
    const pid = Number(pidText);
    assert.deepEqual([first, second], ["first", "second"]);
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    return { action, pid };
  }

  function reaped(pid) {
    return waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        return true;
      }
    }, "reap the cancelled program");
  }

  const cancel = new AbortController();
  const cancelled = await startWaiting(cancel.signal);
  cancel.abort();
  await assert.rejects(within(cancelled.action, "cancel a connected action", 5000), /cancelled/i);
  await reaped(cancelled.pid);

  const interrupted = await startWaiting();
  process.kill(machine.pid, "SIGSTOP");
  try {
    await presence(false, 3500);
    assert.deepEqual(await within(interrupted.action, "fail interrupted machine action", 5000), machineLost);
  } finally {
    process.kill(machine.pid, "SIGCONT");
  }
  await presence(true);
  await reaped(interrupted.pid);
  assert.deepEqual(await window.action(api.work.callerDefault, {}), { runner: true, depth: 0 });

  const interruptedByNetwork = await startWaiting();
  const link = links.at(-1);
  link.detached = true;
  link.downstream.unpipe(link.upstream);
  link.upstream.unpipe(link.downstream);
  link.downstream.resetAndDestroy();
  await waitFor(() => links.at(-1) !== link, "Runner reconnects before the old heartbeat expires", 2500);
  assert.deepEqual(
    await within(interruptedByNetwork.action, "takeover cancels the old invocation", 2500),
    machineLost,
  );
  await presence(true, 2500);
  assert.deepEqual(await window.action(api.work.callerDefault, {}), { runner: true, depth: 0 });
  await reaped(interruptedByNetwork.pid);

  const duplicate = startMachine(keyFile);
  assert.notEqual(await within(machine.exited, "old Runner exits after takeover", 2500), 0);
  assert.match((await machineLogs).join(""), /already connected/i);
  await presence(true);
  assert.deepEqual(await window.action(api.work.callerDefault, {}), { runner: true, depth: 0 });

  duplicate.child.kill("SIGKILL");
  await within(duplicate.child.exited, "Runner exit", 2000);
  await presence(false, 2000);

  const replacement = startMachine(keyFile);
  await presence(true);
  const revocation = await fetch(new URL(`/devices/${device.id}/revoke`, http), {
    method: "POST",
    headers: auth(ownerKey),
  });
  assert.equal(revocation.status, 200);
  assert.notEqual(await within(replacement.child.exited, "stop after revocation", 5000), 0);
  assert.match((await replacement.logs).join(""), /revoked the device key|refused the device key/i);
  await assertRefused(keyFile, /invalid or revoked/i);

  servers[0].kill();
  await servers[0].exited;
  const serverLogs = serverStdout.join("\n") + (await serverStderr);
  assert.ok(
    [key, wrongKey, browserKey, other.key].every((secret) => !serverLogs.includes(secret)),
    "Machine credentials never appear in server logs",
  );

  for (const { logs } of runners) {
    const log = (await logs).join("");
    assert.ok(
      [key, wrongKey, other.key].every((secret) => !log.includes(secret)),
      "Machine credentials never appear in logs",
    );
  }
} finally {
  for (const { child } of runners) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  for (const close of cleanup.reverse()) await close();
  for (const child of servers) {
    child.kill();
    await child.exited;
  }
}
