// This file is copied beside fresh builder output and checked against generated
// references before bundling. Stdio carries real Rust Session protocol messages.
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { TokamakClient, InProcessTransport, WebSocketTransport, type Event } from "@tokamak/sdk";
import { api } from "./a/backend/_generated/api";
import { api as b } from "./b/backend/_generated/api";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 4000);
    })]);
  } finally { clearTimeout(timer); }
}
const lines = createInterface({ input: process.stdin });
let deliver!: (event: Event) => void;
lines.on("line", line => deliver(JSON.parse(line).event));
const native = new InProcessTransport({
  send(request) { process.stdout.write(JSON.stringify({ request }) + "\n"); },
  listen(onEvent) { deliver = onEvent; return () => {}; },
  close() {},
});
const socket = process.argv[3] ? new WebSocket(process.argv[3]) : undefined;
if (socket) await within(new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("WebSocket open failed")), { once: true });
}), "WebSocket open");
const transport = socket ? new WebSocketTransport(socket) : native;
const client = new TokamakClient(transport);
const scenario = process.argv[2];
const hits: string[] = [];
const started = deferred();
const disconnected = deferred();
let stream: ServerResponse | undefined;
let advance: (() => void) | undefined;
let holdClosed = false;
const mock = createServer(async (req, res) => {
  const path = new URL(req.url!, "http://127.0.0.1").pathname;
  hits.push(path);
  if (path === "/started") { res.end("started"); started.resolve(); }
  else if (path === "/redirect") {
    res.writeHead(302, { location: `${base.replace("127.0.0.1", "localhost")}/forbidden` }); res.end();
  } else if (path === "/chunks") {
    res.writeHead(200, { "content-type": "text/plain" });
    stream = res;
    const chunks = ["first", "second", "third"];
    let index = 0;
    advance = () => { if (index < chunks.length) res.write(chunks[index++]); else res.end(); };
    advance();
  } else if (path === "/hold" || path === "/v1/chat/completions") {
    stream = res;
    req.resume();
    res.on("close", () => { holdClosed = true; disconnected.resolve(); });
    if (path === "/hold") {
      res.writeHead(200, { "content-type": "text/plain" }); res.write("first");
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const deltas = ["one", " two", " three"];
      let index = 0;
      advance = () => {
        if (index < deltas.length) {
          res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1,
            model: "mock", choices: [{ index: 0, delta: { content: deltas[index++] }, finish_reason: null }] })}\n\n`);
        } else {
          res.end(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1,
            model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        }
      };
      advance();
    }
  } else if (path === "/ack") { res.end("ack"); advance?.(); }
  else if (path === "/observed") {
    try { await within(disconnected.promise, "HTTP disconnect while action is still alive"); res.end("disconnected"); }
    catch (error) { res.end(String(error)); }
  } else { res.end("unexpected request"); }
});
mock.listen(0, "127.0.0.1");
await new Promise<void>(resolve => mock.once("listening", resolve));
const address = mock.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;

try {
  if (scenario === "contract") {
    // Prove the configured normal call budget is real, then outlive it in action.
    await assert.rejects(client.query(api.ops.timeoutQuery, {}), /wall-clock budget/);
    await assert.rejects(client.mutation(api.ops.timeoutMutation, {}), /wall-clock budget/);
    assert.equal(await client.action(api.ops.idle, { started: `${base}/started`, ms: 600 }), "timer completed");
    // Prevent actions acquiring a db or wrapping nested calls in one transaction.
    const result = await client.action(api.ops.transactions, {}) as {
      noDb: boolean; rolledBack: boolean; before: { value: string }[]; rows: { value: string }[];
    };
    assert.equal(result.noDb, true);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(result.before.map(row => row.value), ["committed before error"]);
    // The second query must own a fresh snapshot and see the intervening commit.
    assert.deepEqual(result.rows.map(row => row.value).sort(), ["committed after query", "committed before error"]);
    await assert.rejects(client.action(api.ops.failedAction, {}), /action failure sentinel/);
    assert.deepEqual((await client.query(api.ops.list, {})).map(row => row.value).sort(),
      ["committed after query", "committed before error", "survives action failure"]);
  } else if (scenario === "lane") {
    // Prevent the pending action response from stalling the same connection.
    let settled = false;
    const pending = client.action(api.ops.idle, { started: `${base}/started`, ms: 1000 });
    pending.then(() => { settled = true; }, () => { settled = true; });
    await within(started.promise, "action timer started");
    await client.query(api.ops.list, {});
    await client.mutation(api.ops.append, { value: "while action pending" });
    assert.equal(settled, false, "query and mutation must finish before the action timer");
    assert.equal(await pending, "timer completed");
  } else if (scenario === "fetch") {
    // Prevent transactional effects and deny missing grants before sending bytes.
    await assert.rejects(client.query(api.ops.queryFetch, { url: `${base}/query` }), /fetch is forbidden in queries and mutations/);
    await assert.rejects(client.mutation(api.ops.mutationFetch, { url: `${base}/mutation` }), /fetch is forbidden in queries and mutations/);
    let denial: unknown;
    try { await client.action(b.ops.deniedFetch, { url: `${base}/denied` }); } catch (error) { denial = error; }
    assert.deepEqual(hits, [], "denied fetches must send no request");
    assert.match(String(denial), /fetch permission denied: requires net:127\.0\.0\.1/);
    assert.deepEqual(await client.action(api.ops.streamed, { url: `${base}/chunks`, ack: `${base}/ack` }), ["first", "second", "third"]);
    assert.deepEqual(hits, ["/chunks", "/ack", "/ack", "/ack"]);
    // Prevent a granted origin lending permission to an ungranted redirect host.
    await assert.rejects(client.action(api.ops.fetchText, { url: `${base}/redirect` }), /fetch permission denied: requires net:localhost/);
    assert.deepEqual(hits, ["/chunks", "/ack", "/ack", "/ack", "/redirect"]);
  } else if (scenario === "abort") {
    // Prevent a JS-only abort which leaves native HTTP alive until world teardown.
    assert.deepEqual(await client.action(api.ops.abortFetch, { url: `${base}/hold`, observed: `${base}/observed` }),
      { first: "first", error: "AbortError", observed: "disconnected" });
    assert.equal(holdClosed, true);
  } else if (scenario === "time") {
    // Prevent deterministic transaction inputs leaking into the action world,
    // and real action time leaking into nested query/mutation worlds.
    const result = await client.action(api.ops.time, {}) as {
      before: number; after: number; query: { before: number; after: number }; mutation: { before: number; after: number };
    };
    assert.ok(result.after - result.before >= 30, JSON.stringify(result));
    assert.equal(result.query.before, result.query.after);
    assert.equal(result.mutation.before, result.mutation.after);
  } else if (scenario === "exports") {
    // Prevent action.runQuery/runMutation bypassing cross-plugin exports.
    assert.equal(await client.action(api.ops.publicCall, {}), "public");
    for (const write of [false, true])
      await assert.rejects(client.action(api.ops.exports, { write }), new RegExp(`ops:private${write ? "Write" : "Read"} is not exported by b`));
  } else if (scenario === "ai" || scenario === "ai-abort") {
    // Prevent SDK compatibility regressions hidden by hand-written fetch probes.
    const abort = scenario === "ai-abort";
    const result = await client.action(api.ai.stream, {
      baseURL: `${base}/v1`, abort, ack: `${base}/ack`, observed: `${base}/observed`,
    });
    assert.deepEqual(result, { deltas: abort ? ["one", " two"] : ["one", " two", " three"],
      aborted: abort, observed: abort ? "disconnected" : "complete" });
    assert.equal(hits.filter(path => path === "/v1/chat/completions").length, 1);
    if (abort) assert.equal(holdClosed, true);
  } else if (scenario === "missing") {
    // Prevent unsupported APIs silently returning a plausible but unusable value.
    await assert.rejects(client.action(api.ops.missing, {}), /WebSocket.*not supported by Tokamak web APIs/);
  } else { throw new Error(`unknown scenario: ${scenario}`); }
  process.stdout.write(JSON.stringify({ done: true }) + "\n");
} finally {
  transport.close();
  stream?.destroy();
  mock.closeAllConnections();
  await new Promise<void>(resolve => mock.close(() => resolve()));
  lines.close();
  process.stdin.pause();
}
