// This file is copied beside fresh builder output and checked against generated
// references before bundling. Stdio carries real Rust Session protocol messages.
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { TokamakClient, InProcessTransport, WebSocketTransport, type Event } from "@tokamak/sdk";
import { api } from "./a/src/server/_generated/api";
import { api as b } from "./b/src/server/_generated/api";
import { within } from "./within";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const lines = createInterface({ input: process.stdin });
let deliver!: (event: Event) => void;
lines.on("line", (line) => deliver(JSON.parse(line).event));
const native = new InProcessTransport({
  send(request) {
    process.stdout.write(JSON.stringify({ request }) + "\n");
  },
  listen(onEvent) {
    deliver = onEvent;
    return () => {};
  },
  close() {},
});
const socket = process.argv[3] ? new WebSocket(process.argv[3]) : undefined;
if (socket)
  await within(
    new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket open failed")), { once: true });
    }),
    "WebSocket open",
  );
const transport = socket ? new WebSocketTransport(socket) : native;
const client = new TokamakClient(transport);
const scenario = process.argv[2];
const hits: string[] = [];
const started = deferred();
const disconnected = deferred();
let stream: ServerResponse | undefined;
let advance: (() => void) | undefined;
let holdClosed = false;
let closedAt = 0;
const held = new Set<ServerResponse>();
let lastClosed: Promise<void> = Promise.resolve();
let broken: ServerResponse | undefined;
const mock = createServer(async (req, res) => {
  const path = new URL(req.url!, "http://127.0.0.1").pathname;
  hits.push(path);
  if (path === "/echo") {
    if (req.method === "POST") {
      for await (const chunk of req) res.write(chunk);
      res.end();
    } else res.end("response bytes");
  } else if (path === "/early") {
    req.resume();
    res.writeHead(204);
    res.end();
  } else if (path === "/broken") {
    broken = res;
    res.writeHead(200, { "content-length": "100" });
    res.write("first");
  } else if (path === "/break") {
    broken!.destroy();
    res.end("broken");
  } else if (path === "/started") {
    res.end("started");
    started.resolve();
  } else if (path === "/redirect-loopback") {
    res.writeHead(302, { location: `${base}/forbidden` });
    res.end();
  } else if (path === "/redirect") {
    res.writeHead(302, { location: `${base.replace("127.0.0.1", "localhost")}/forbidden` });
    res.end();
  } else if (path === "/chunks") {
    res.writeHead(200, { "content-type": "text/plain" });
    stream = res;
    const chunks = ["first", "second", "third"];
    let index = 0;
    advance = () => {
      if (index < chunks.length) res.write(chunks[index++]);
      else res.end();
    };
    advance();
  } else if (path === "/hold") {
    stream = res;
    req.resume();
    held.add(res);
    lastClosed = new Promise<void>((resolve) => res.once("close", () => resolve()));
    res.on("close", () => {
      held.delete(res);
      holdClosed = true;
      closedAt = Date.now();
      disconnected.resolve();
    });
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("first");
  } else if (path === "/ack") {
    res.end("ack");
    advance?.();
  } else if (path === "/observed") {
    try {
      await within(disconnected.promise, "HTTP disconnect while action is still alive");
      res.end("disconnected");
    } catch (error) {
      res.end(String(error));
    }
  } else {
    res.end("unexpected request");
  }
});
mock.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => mock.once("listening", resolve));
const address = mock.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;

try {
  if (scenario === "contract") {
    // Prove the configured normal call budget is real, then outlive it in action.
    await assert.rejects(client.query(api.ops.timeoutQuery, {}), /wall-clock budget/);
    await assert.rejects(client.mutation(api.ops.timeoutMutation, {}), /wall-clock budget/);
    assert.equal(
      await client.action(api.ops.idle, { started: `${base}/started`, ms: 600 }),
      "timer completed",
    );
    // Prevent actions acquiring a db or wrapping nested calls in one transaction.
    const result = (await client.action(api.ops.transactions, {})) as {
      noDb: boolean;
      rolledBack: boolean;
      before: { value: string }[];
      rows: { value: string }[];
    };
    assert.equal(result.noDb, true);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(
      result.before.map((row) => row.value),
      ["committed before error"],
    );
    // The second query must own a fresh snapshot and see the intervening commit.
    assert.deepEqual(result.rows.map((row) => row.value).sort(), [
      "committed after query",
      "committed before error",
    ]);
    await assert.rejects(client.action(api.ops.failedAction, {}), /action failure sentinel/);
    assert.deepEqual((await client.query(api.ops.list, {})).map((row) => row.value).sort(), [
      "committed after query",
      "committed before error",
      "survives action failure",
    ]);
  } else if (scenario === "lane") {
    // Prevent the pending action response from stalling the same connection.
    let settled = false;
    const pending = client.action(api.ops.idle, { started: `${base}/started`, ms: 1000 });
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await within(started.promise, "action timer started");
    await client.query(api.ops.list, {});
    await client.mutation(api.ops.append, { value: "while action pending" });
    assert.equal(settled, false, "query and mutation must finish before the action timer");
    assert.equal(await pending, "timer completed");
  } else if (scenario === "oversize") {
    // An oversized action result must fail only its own call (TKM-44 1 MiB
    // wire semantics), never the connection or the action lane behind it.
    await assert.rejects(
      client.action(api.ops.oversized, { bytes: 1_048_577 }),
      /result too large \(1 MiB limit\)/,
    );
    assert.equal(await client.action(api.ops.oversized, { bytes: 16 }), "x".repeat(16));
    await client.mutation(api.ops.append, { value: "after oversized action" });
    assert.deepEqual(
      (await client.query(api.ops.list, {})).map((row) => row.value),
      ["after oversized action"],
    );
  } else if (scenario === "fetch") {
    // Prevent transactional effects and deny missing grants before sending bytes.
    await assert.rejects(
      client.query(api.ops.queryFetch, { url: `${base}/query` }),
      /fetch is forbidden in queries and mutations/,
    );
    await assert.rejects(
      client.mutation(api.ops.mutationFetch, { url: `${base}/mutation` }),
      /fetch is forbidden in queries and mutations/,
    );
    let denial: unknown;
    try {
      await client.action(b.ops.deniedFetch, { url: `${base}/denied` });
    } catch (error) {
      denial = error;
    }
    assert.deepEqual(hits, [], "denied fetches must send no request");
    assert.match(String(denial), /fetch permission denied: requires net:127\.0\.0\.1/);
    assert.deepEqual(await client.action(api.ops.streamed, { url: `${base}/chunks`, ack: `${base}/ack` }), [
      "first",
      "second",
      "third",
    ]);
    assert.deepEqual(hits, ["/chunks", "/ack", "/ack", "/ack"]);
    // Prevent a granted origin lending permission to an ungranted redirect host.
    await assert.rejects(
      client.action(api.ops.fetchText, { url: `${base}/redirect` }),
      /fetch permission denied: requires net:localhost/,
    );
    assert.deepEqual(hits, ["/chunks", "/ack", "/ack", "/ack", "/redirect"]);
  } else if (scenario === "abort") {
    // Prevent a JS-only abort which leaves native HTTP alive until world teardown.
    assert.deepEqual(
      await client.action(api.ops.abortFetch, { url: `${base}/hold`, observed: `${base}/observed` }),
      { first: "first", error: "AbortError", observed: "disconnected" },
    );
    assert.equal(holdClosed, true);
  } else if (scenario === "time") {
    // Prevent deterministic transaction inputs leaking into the action world,
    // and real action time leaking into nested query/mutation worlds.
    const result = (await client.action(api.ops.time, {})) as {
      before: number;
      after: number;
      query: { before: number; after: number };
      mutation: { before: number; after: number };
    };
    assert.ok(result.after - result.before >= 30, JSON.stringify(result));
    assert.equal(result.query.before, result.query.after);
    assert.equal(result.mutation.before, result.mutation.after);
  } else if (scenario === "exports") {
    // Prevent action.runQuery/runMutation bypassing cross-plugin exports.
    assert.equal(await client.action(api.ops.publicCall, {}), "public");
    for (const write of [false, true])
      await assert.rejects(
        client.action(api.ops.exports, { write }),
        new RegExp(`ops:private${write ? "Write" : "Read"} is not exported by b`),
      );
  } else if (scenario === "network-boundary") {
    // The Rust harness verifies each shim answer before starting this driver.
    for (const host of ["loopback", "private", "metadata", "mapped"]) {
      await assert.rejects(
        within(
          client.action(b.ops.deniedFetch, {
            url: `http://${host}.tkm.test:${address.port}/boundary-${host}`,
          }),
          `${host} address rejection`,
        ),
        /no permitted public addresses/,
      );
    }
    assert.deepEqual(hits, [], "hostname grants must not reach non-public connected addresses");
    // Explicit local grants still work; redirects must recheck their destination.
    assert.equal(
      await client.action(b.ops.deniedFetch, { url: `${base.replace("127.0.0.1", "localhost")}/local` }),
      "unexpected request",
    );
    await assert.rejects(
      client.action(b.ops.deniedFetch, {
        url: `${base.replace("127.0.0.1", "localhost")}/redirect-loopback`,
      }),
      /requires net:127\.0\.0\.1/,
    );
    for (const host of ["2130706433", "0x7f.1", "127.1", "[::ffff:127.0.0.1]"]) {
      const url: string = `http://${host}:${address.port}/alternate`;
      await assert.rejects(client.action(b.ops.deniedFetch, { url }), /requires net:127\.0\.0\.1/);
      assert.equal(await client.action(api.ops.fetchText, { url }), "unexpected request");
    }
    assert.deepEqual(hits, ["/local", "/redirect-loopback", ...Array(4).fill("/alternate")]);
  } else if (scenario === "abort-busy") {
    // Disconnect must precede the end of synchronous JS, with no later job.
    const ended = await client.action(api.web.abortBusy, { url: `${base}/hold`, ack: `${base}/ack` });
    await within(disconnected.promise, "abort while JS busy");
    assert.ok(closedAt < ended, `HTTP closed at ${closedAt}, JS ended at ${ended}`);
  } else if (scenario === "abandoned-return" || scenario === "abandoned-throw") {
    // Keep the server/pool alive and submit no next action before observing EOF.
    for (let i = 0; i < 130; i++) {
      const pending: Promise<unknown> = client.action(api.web.abandoned, {
        url: `${base}/hold`,
        mode: scenario.slice("abandoned-".length),
      });
      if (scenario === "abandoned-throw") await assert.rejects(pending, /abandon sentinel/);
      else assert.equal(await pending, "abandoned");
      await within(lastClosed, `HTTP disconnect after retirement ${i} with idle worker`);
      assert.equal(held.size, 0);
    }
    assert.equal(await client.action(api.web.timers, {}), "healthy");
  } else if (scenario.startsWith("slots-readers-")) {
    const mode = scenario.slice("slots-readers-".length);
    assert.equal(
      await client.action(api.web.readers, {
        url: `${base}/${mode === "cancel" ? "hold" : "broken"}`,
        ack: `${base}/break`,
        mode,
      }),
      "healthy",
    );
  } else if (scenario.startsWith("slots-uploads-")) {
    const mode = scenario.slice("slots-uploads-".length);
    assert.equal(
      await client.action(api.web.uploads, {
        source: `${base}/hold`,
        target: mode === "denied" ? `${base.replace("127.0.0.1", "localhost")}/denied` : `${base}/early`,
        mode,
      }),
      "healthy",
    );
    assert.equal(hits.filter((path) => path === "/hold").length, 130);
    await within(
      Promise.all(
        [...held].map((response) => new Promise<void>((resolve) => response.once("close", () => resolve()))),
      ),
      "upload source disconnects",
    );
    assert.equal(held.size, 0, "all transferred fetch upload sources must disconnect");
  } else if (scenario === "bodies") {
    // Reuse must fail before another HTTP request reaches the mock.
    assert.equal(await client.action(api.web.bodies, { url: `${base}/echo` }), "bodies preserved");
    assert.deepEqual(hits, ["/echo", "/echo", "/echo"]);
  } else if (scenario === "params") {
    // Test retained object identity and observable URL bytes in QuickJS.
    assert.equal(await client.action(api.web.params, {}), "params live");
  } else if (scenario.startsWith("slots-decoders-")) {
    // A completed action alone cannot prove per-resource slot release.
    assert.equal(
      await client.action(api.web.decoders, { mode: scenario.slice("slots-decoders-".length) }),
      "healthy",
    );
  } else if (scenario === "slots-timers") {
    // Every cycle must release capacity before the next allocation.
    assert.equal(await client.action(api.web.timers, {}), "healthy");
  } else if (scenario === "missing") {
    // Prevent unsupported APIs silently returning a plausible but unusable value.
    await assert.rejects(client.action(api.ops.missing, {}), /WebSocket.*not supported by Tokamak web APIs/);
  } else {
    throw new Error(`unknown scenario: ${scenario}`);
  }
  process.stdout.write(JSON.stringify({ done: true }) + "\n");
} finally {
  transport.close();
  stream?.destroy();
  broken?.destroy();
  for (const response of held) response.destroy();
  mock.closeAllConnections();
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  lines.close();
  process.stdin.pause();
}
