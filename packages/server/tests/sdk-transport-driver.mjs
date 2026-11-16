// TKM7 end-to-end driver: identical public SDK calls over native messages and
// real headless WebSockets. Native stdin/stdout is only a test host bridge to
// Rust Session; it does not emulate the database, dispatcher, or SDK transport.
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { TokamakClient, InProcessTransport, WebSocketTransport, createApi } from "../../sdk/src/index.ts";
import { buildFeature } from "./build-feature.mjs";

const api = createApi();
const within = (promise, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 20000);
      timer.unref();
    }),
  ]);

function observation(client) {
  const events = [];
  const waiting = [];
  const stop = client.subscribe(api.probe.list, { table: "items" }, (event) => {
    events.push(event);
    waiting.shift()?.(event);
  });
  let consumed = 0;
  return {
    events,
    stop,
    async next() {
      const event =
        events[consumed++] ??
        (await within(new Promise((resolve) => waiting.push(resolve)), "subscription event"));
      assert.ok("value" in event, event.error?.message);
      return event.value;
    },
  };
}

async function acceptance(transports) {
  const [writer, reader] = transports.map((transport) => new TokamakClient(transport));
  const own = observation(writer),
    other = observation(reader);
  assert.deepEqual(await own.next(), []);
  assert.deepEqual(await other.next(), []);
  // Errors use the same correlated stream; neither wrong-kind request may run
  // a handler or write, and failed multi-write calls must not publish updates.
  await assert.rejects(writer.query(api.probe.insert, { table: "items", value: {} }));
  await assert.rejects(writer.mutation(api.probe.list, { table: "items" }));
  await assert.rejects(writer.query(api.probe.absent, {}));
  for (const caught of [false, true]) await assert.rejects(writer.mutation(api.probe.rollback, { caught }));
  assert.deepEqual(await writer.query(api.probe.list, { table: "items" }), []);
  assert.equal(own.events.length, 1, "failed transactions must not invalidate");
  assert.equal(other.events.length, 1);
  assert.deepEqual(await writer.query(api.probe.readonly, {}), {
    methods: ["get", "query"],
    canWrite: false,
  });
  const id = await writer.mutation(api.probe.insert, {
    table: "items",
    value: { title: "TKM7", done: false },
  });
  // This assertion is intentionally BEFORE awaiting an update: merely eventual
  // delivery would miss a regression in the writer update-before-reply fence.
  assert.equal(own.events.length, 2, "writer update must precede mutation resolution");
  const rows = await own.next();
  assert.equal(rows[0]._id, id);
  assert.equal(rows[0].title, "TKM7");
  assert.deepEqual(await other.next(), rows);
  assert.deepEqual(await reader.query(api.probe.list, { table: "items" }), rows);
  own.stop();
  own.stop();
  other.stop();
  // Ordered query is the unsubscribe barrier; no sleep-based silence check.
  await writer.query(api.probe.count, {});
  await reader.query(api.probe.count, {});
  await writer.mutation(api.probe.patch, { id, value: { done: true } });
  assert.equal(own.events.length, 2);
  assert.equal(other.events.length, 2);
  const failures = [];
  writer.subscribe(api.probe.insert, { table: "items", value: {} }, (event) => failures.push(event));
  await writer.query(api.probe.count, {});
  assert.equal(failures.length, 1);
  assert.ok(failures[0].error instanceof Error, "registration error is delivered, not stranded");
  return id;
}

async function native() {
  const listeners = new Map();
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const { client, event } = JSON.parse(line);
    listeners.get(client)?.(event);
  });
  const transports = [0, 1].map(
    (client) =>
      new InProcessTransport({
        send(request) {
          process.stdout.write(JSON.stringify({ client, request }) + "\n");
        },
        listen(onEvent) {
          listeners.set(client, onEvent);
          return () => listeners.delete(client);
        },
        close() {
          process.stdout.write(JSON.stringify({ client, close: true }) + "\n");
        },
      }),
  );
  await within(acceptance(transports), "native SDK acceptance");
  transports.forEach((t) => t.close());
  process.stdout.write(JSON.stringify({ done: true }) + "\n");
  lines.close();
  process.stdin.pause();
}

async function socket(url, opened = () => {}) {
  const ws = new WebSocket(url);
  await within(
    new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("WebSocket open failed")), { once: true });
    }),
    "open WebSocket",
  );
  opened(ws);
  return new WebSocketTransport(ws);
}

async function headless(binary) {
  const feature = await buildFeature();
  const root = await mkdtemp(join(feature, "disk-"));
  const data = join(root, "storage");
  let child;
  async function start() {
    child = Bun.spawn(
      [
        binary,
        "--bundle",
        join(feature, "dist/bundle.js"),
        "--data",
        data,
        "--listen",
        "127.0.0.1:0",
        "--workers",
        "2",
        "--queue",
        "8",
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const lines = createInterface({ input: Readable.fromWeb(child.stdout) });
    const url = await within(
      new Promise((resolve, reject) => {
        lines.on("line", (line) => {
          const match = line.match(/ws:\/\/\S+/);
          if (match) resolve(match[0]);
        });
        lines.on("close", () => reject(new Error("headless exited before announcing listener")));
      }),
      "headless readiness",
    );
    return url;
  }
  async function stop() {
    child.kill("SIGTERM");
    assert.equal(await within(child.exited, "headless graceful shutdown"), 0);
    child = undefined;
  }
  const transports = [];
  try {
    // CLI local-only validation must happen without creating storage.
    const refused = Bun.spawn([binary, "--listen", "0.0.0.0:0", "--data", data], {
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.notEqual(await refused.exited, 0);
    assert.match(await new Response(refused.stderr).text(), /loopback/);
    const url = await start();
    transports.push(await socket(url), await socket(url));
    const id = await within(acceptance(transports), "headless SDK acceptance");
    // Leave a live subscription/idle socket at SIGTERM: upgraded connections
    // must be retired rather than preventing the storage shutdown barrier.
    const idle = observation(new TokamakClient(transports[1]));
    await idle.next();
    await stop();
    const reopened = await start();
    transports.push(await socket(reopened));
    const rows = await new TokamakClient(transports[2]).query(api.probe.list, { table: "items" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]._id, id);
    assert.equal(rows[0].done, true);
    await stop();
  } finally {
    transports.forEach((t) => t.close());
    if (child) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(feature, { recursive: true, force: true });
  }
}

async function disconnect(url) {
  let ws;
  const transport = await socket(url, (socket) => {
    ws = socket;
  });
  try {
    const live = observation(new TokamakClient(transport));
    await live.next();
    const closed = new Promise((resolve) => ws.addEventListener("close", resolve, { once: true }));
    transport.close();
    await within(closed, "peer close");
  } finally {
    transport.close();
  }
}

if (process.argv[2] === "disconnect") await disconnect(process.argv[3]);
else if (process.argv[2] === "native") await native();
else if (process.argv[2] === "headless") await headless(process.argv[3]);
else throw new Error("expected native or headless <binary>");
