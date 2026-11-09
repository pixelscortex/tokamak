// Independent real-CLI regressions: command saturation and incomplete HTTP
// upgrade peers must not escape the awaited storage/process shutdown barrier.
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { TokamakClient, WebSocketTransport, createApi } from "../../sdk/src/index.ts";
import { buildFeature } from "./build-feature.mjs";
const api = createApi();
async function deadline(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: exceeded ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function connection(url) {
  const socket = new WebSocket(url);
  try {
    await deadline(new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
    }), 10000, "SDK connect");
    const transport = new WebSocketTransport(socket);
    return { socket, transport, client: new TokamakClient(transport) };
  } catch (error) { socket.close(); throw error; }
}
async function fixture(binary, scenario) {
  const feature = await buildFeature();
  const dataRoot = await mkdtemp(join(feature, "shutdown-disk-"));
  let process;
  let lines;
  let stderr;
  const connections = [];
  const peers = [];
  async function start() {
    process = Bun.spawn([binary, "--bundle", join(feature, "dist/bundle.js"), "--data", join(dataRoot, "db"),
      "--listen", "127.0.0.1:0", "--workers", "2", "--queue", "8", "--call-ms", "5000"],
      { stdout: "pipe", stderr: "pipe" });
    stderr = new Response(process.stderr).text();
    lines = createInterface({ input: Readable.fromWeb(process.stdout) });
    return await deadline(new Promise((resolve, reject) => {
      lines.on("line", line => { const match = line.match(/ws:\/\/\S+/); if (match) resolve(match[0]); });
      lines.once("close", () => reject(new Error("CLI exited before readiness")));
    }), 15000, "CLI startup");
  }
  async function stop(ms = 10000) {
    process.kill("SIGTERM");
    const code = await deadline(process.exited, ms, "SIGTERM with peer held open must finish");
    const error = await stderr;
    lines.close(); lines = undefined;
    process = undefined;
    return { code, error };
  }
  async function open(url) {
    const wire = await connection(url); connections.push(wire); return wire;
  }
  try { await scenario({ start, stop, open, peers }); }
  finally {
    connections.forEach(wire => wire.transport.close());
    peers.forEach(peer => peer.destroy());
    if (process) { process.kill("SIGKILL"); await process.exited; await stderr; }
    lines?.close();
    await rm(feature, { recursive: true, force: true });
  }
}

// Keep the real worker occupied without allowing backend code to read live time.
// Dry runs calibrate the same bounded loop without leaving extra database rows.
async function occupancy(client) {
  let iterations = 1_000_000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const start = performance.now();
    await client.mutation(api.shutdown.slowInsert, { iterations, dryRun: true });
    const elapsed = performance.now() - start;
    if (elapsed >= 1300 && elapsed <= 2000) return iterations;
    iterations = Math.max(1, Math.floor(iterations * 1500 / Math.max(elapsed, 1)));
  }
  throw new Error("Cannot calibrate deterministic shutdown worker occupancy");
}

async function saturated(binary) {
  // The no-queue control establishes the same worker/bundle/disk path succeeds.
  // The saturated run then requires socket closure as admission failure evidence,
  // not a sleep pretending that 64 messages have reached the coordinator.
  for (const queued of [0, 64]) await fixture(binary, async ({ start, stop, open }) => {
    const url = await start();
    const writer = await open(url);
    await writer.client.query(api.probe.count, {}); // full server/SDK readiness barrier
    const iterations = await occupancy(writer.client);
    let completed = false;
    const mutation = writer.client.mutation(api.shutdown.slowInsert, { iterations }).then(
      value => { completed = true; return { value }; }, error => ({ error: error.message }));
    if (queued === 0) {
      // Control has no competing queue: wait for its real reply, not a timer.
      assert.ok((await deadline(mutation, 10000, "control mutation")).value);
    } else {
      const closed = new Promise(resolve => writer.socket.addEventListener("close", resolve, { once: true }));
      // One sentinel beyond capacity forces an observable refusal. The mutation
      // and queries share one FIFO WebSocket, so the mutation precedes every fill
      // request. SDK capacity is 128, larger than this entire workload.
      const requests = Array.from({ length: queued + 1 }, () =>
        writer.client.query(api.probe.count, {}).then(value => ({ value }), error => ({ error: error.message })));
      await deadline(closed, 1000, "queue overflow must be observed before calibrated handler retirement");
      assert.equal(completed, false, "mutation already replied; saturation did not hold accepted work");
      assert.ok((await mutation).error?.includes("closed"), "overflow must fail the connection explicitly");
      // All requests have rejection handlers; do not await retirement before SIGTERM.
      void Promise.all(requests);
    }
    const stopped = await stop();
    // Reopen even after an erroneous nonzero exit, to report storage durability
    // alongside the exit code rather than masking data loss behind the first assert.
    const reopened = await open(await start());
    const rows = await deadline(reopened.client.query(api.probe.list, { table: "items" }), 10000, "reopened list");
    const final = await stop();
    assert.deepEqual({ queued, exit: stopped.code, stderr: stopped.error.trim(), persisted: rows.length,
      value: rows[0]?.value, reopenExit: final.code },
      { queued, exit: 0, stderr: "", persisted: 1, value: "accepted before shutdown", reopenExit: 0 },
      "graceful shutdown must drain accepted mutation despite saturated command admission");
  });
}

async function partialHeaders(binary) {
  await fixture(binary, async ({ start, stop, open, peers }) => {
    const url = await start();
    const healthy = await open(url);
    const id = await healthy.client.mutation(api.probe.insert, { table: "items", value: { value: "partial-header persistence" } });
    const address = new URL(url);
    const peer = connect({ host: address.hostname, port: Number(address.port) });
    peers.push(peer);
    peer.on("error", () => {}); // shutdown is allowed to reset this unfinished peer
    await deadline(new Promise((resolve, reject) => { peer.once("connect", resolve); peer.once("error", reject); }), 10000, "raw peer connect");
    await new Promise((resolve, reject) => peer.write("GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n", error => error ? reject(error) : resolve()));
    // Establish another successful upgrade/query AFTER the raw peer connects.
    // This is accept-loop progress evidence, rather than a guessed sleep while
    // the unfinished connection might still be waiting in the TCP listen backlog.
    const barrier = await open(url);
    assert.equal(await barrier.client.query(api.probe.count, {}), 1);
    const stopped = await stop(3000);
    assert.equal(stopped.code, 0, stopped.error);
    // Keep the incomplete peer open through shutdown AND immediate disk reopen.
    const reopened = await open(await start());
    const rows = await reopened.client.query(api.probe.list, { table: "items" });
    assert.equal(rows[0]._id, id);
    assert.equal((await stop()).code, 0);
  });
}

async function queuedMutations(binary) {
  for (const queued of [1, 8]) await fixture(binary, async ({ start, stop, open }) => {
    const wire = await open(await start());
    await wire.client.query(api.probe.count, {});
    const iterations = await occupancy(wire.client);
    let replies = 0;
    const pending = [wire.client.mutation(api.shutdown.slowInsert, { iterations }).then(
      value => { replies++; return { value }; }, error => ({ error: error.message }))];
    for (let i = 1; i <= queued; i++) pending.push(wire.client.mutation(api.probe.insert,
      { table: "items", value: { value: `queued-${i}` } }).then(
        value => { replies++; return { value }; }, error => ({ error: error.message })));
    // Bun's native client exposes protocol Ping/Pong. Tungstenite reaches this
    // ping only after the preceding FIFO text frames have been consumed by the
    // adapter (and request admission has returned). Pong is therefore positive
    // admission evidence without waiting for queued mutations to execute.
    // This is test-driver networking, not an SDK/runtime feature capability.
    const marker = `admitted-${queued}`;
    let observe;
    const pong = new Promise(resolve => {
      observe = event => { if (Buffer.from(event.data).toString() === marker) resolve(); };
      wire.socket.addEventListener("pong", observe);
    });
    try {
      wire.socket.ping(marker);
      await deadline(pong, 1000, "post-mutation ping admission barrier before active handler retires");
    } finally { wire.socket.removeEventListener("pong", observe); }
    assert.equal(replies, 0, "active mutation retired before admission was observed");
    const stopped = await stop();
    await Promise.all(pending); // close settles all observers, without replay
    const reopened = await open(await start());
    const rows = await deadline(reopened.client.query(api.probe.list, { table: "items" }), 10000, "queued mutation durability");
    const final = await stop();
    const values = rows.map(row => row.value).sort();
    const expected = ["accepted before shutdown", ...Array.from({ length: queued }, (_, i) => `queued-${i + 1}`)].sort();
    assert.deepEqual({ queued, exit: stopped.code, stderr: stopped.error.trim(), values, reopenExit: final.code },
      { queued, exit: 0, stderr: "", values: expected, reopenExit: 0 },
      "successful CLI shutdown must persist every admitted queued mutation after sockets close");
  });
}

if (process.argv[2] === "queued-mutations") await queuedMutations(process.argv[3]);
else if (process.argv[2] === "saturated") await saturated(process.argv[3]);
else if (process.argv[2] === "partial-headers") await partialHeaders(process.argv[3]);
else throw new Error("expected saturated or partial-headers <binary>");
