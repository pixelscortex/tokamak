// TKM7 transport failure contracts. These narrow fake connections exercise
// boundary failures impractical to force reliably with a kernel socket; real
// SDK/backend parity is separately exercised by server/tests/sdk_transport.rs.
import { test, expect } from "bun:test";
import { TokamakClient, InProcessTransport, WebSocketTransport, createApi } from "../src/index.ts";
const api = createApi();

function native() {
  const sent = [];
  let deliver,
    fail,
    stops = 0,
    closes = 0;
  const transport = new InProcessTransport({
    send(request) {
      sent.push(request);
    },
    listen(event, close) {
      deliver = event;
      fail = close;
      return () => stops++;
    },
    close() {
      closes++;
    },
  });
  return {
    transport,
    sent,
    event: (event) => deliver(event),
    fail: (error) => fail(error),
    counts: () => ({ stops, closes }),
  };
}

// Correlation is by ID, not FIFO; null success, registration error, rerun error,
// unsubscribe and mutation fences must survive observer exceptions and disorder.
test("SDK message transport correlates results and isolates subscription observers", async () => {
  const wire = native(),
    client = new TokamakClient(wire.transport);
  const first = client.query(api.items.one, {});
  const second = client.query(api.items.two, {});
  wire.event({ type: "response", id: 2, result: { Ok: null } });
  wire.event({ type: "response", id: 1, result: { Err: "query failed" } });
  expect(await second).toBeNull();
  await expect(first).rejects.toThrow("query failed");
  const events = [];
  const stop = client.subscribe(api.items.list, {}, (event) => {
    events.push(event);
    throw new Error("render failed");
  });
  wire.event({ type: "subscription", id: 3, result: { Ok: [] } });
  const mutation = client.mutation(api.items.add, {});
  wire.event({ type: "subscription", id: 3, result: { Err: "rerun failed" } });
  wire.event({ type: "response", id: 4, result: { Ok: "items:a" } });
  expect(await mutation).toBe("items:a");
  expect(events[1].error.message).toBe("rerun failed");
  stop();
  stop();
  expect(wire.sent.filter((request) => request.type === "unsubscribe")).toEqual([
    { type: "unsubscribe", id: 3 },
  ]);
  wire.event({ type: "subscription", id: 3, result: { Ok: ["late"] } });
  expect(events).toHaveLength(2);
  const failed = [];
  client.subscribe(api.items.missing, {}, (event) => failed.push(event));
  wire.event({ type: "response", id: 5, result: { Err: "not a registered query" } });
  wire.fail(new Error("socket ended"));
  expect(failed).toHaveLength(1);
  expect(failed[0].error.message).toBe("not a registered query");
});

// Close must fail every accepted pending call/subscription once, suppress late
// frames, and never silently replay a mutation whose commit outcome is unknown.
test("SDK close rejects pending work once and prevents further admission", async () => {
  const wire = native(),
    client = new TokamakClient(wire.transport),
    events = [];
  const pending = client.mutation(api.items.add, {});
  client.subscribe(api.items.list, {}, (event) => events.push(event));
  const rejected = pending.catch((error) => error);
  wire.transport.close();
  wire.transport.close();
  expect((await rejected).message).toContain("outcome");
  expect(events).toHaveLength(1);
  expect(events[0].error.message).toContain("outcome");
  expect(wire.counts()).toEqual({ stops: 1, closes: 1 });
  wire.event({ type: "response", id: 1, result: { Ok: "late" } });
  await expect(client.query(api.items.list, {})).rejects.toThrow("closed");
  expect(wire.sent).toHaveLength(2);
});

// Capacity is bounded before transport send; settling one call frees exactly
// that capacity, rather than leaving the client permanently overloaded.
test("SDK bounds calls and subscriptions and releases capacity on settlement", async () => {
  const wire = native();
  const pending = Array.from({ length: 128 }, () => wire.transport.query("items:list", {}));
  await expect(wire.transport.query("items:list", {})).rejects.toThrow("capacity");
  expect(wire.sent).toHaveLength(128);
  wire.event({ type: "response", id: 1, result: { Ok: [] } });
  expect(await pending[0]).toEqual([]);
  pending.push(wire.transport.query("items:list", {}));
  const stops = Array.from({ length: 128 }, () => wire.transport.subscribe("items:list", {}, () => {}));
  expect(() => wire.transport.subscribe("items:list", {}, () => {})).toThrow("capacity");
  stops[0]();
  wire.transport.subscribe("items:list", {}, () => {});
  const settled = Promise.allSettled(pending);
  wire.transport.close();
  expect((await settled).filter((result) => result.status === "rejected")).toHaveLength(128);
});

function socket() {
  const listeners = new Map();
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    closes: 0,
    send(text) {
      this.sent.push(JSON.parse(text));
    },
    close() {
      this.closes++;
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
  };
  return { ws, emit: (data) => listeners.get("message")?.({ data }), listeners };
}

// Malformed frames fail the entire connection explicitly, including all pending
// mutations. Validation must not reinterpret a malformed Result as success.
test("WebSocket SDK rejects malformed frames without stranding accepted work", async () => {
  for (const data of [
    "not json",
    "null",
    "{}",
    JSON.stringify({ type: "response", id: 1, result: { Ok: null, Err: "both" } }),
    JSON.stringify({ type: "response", id: 1.5, result: { Ok: null } }),
    new Uint8Array([1]),
  ]) {
    const wire = socket(),
      transport = new WebSocketTransport(wire.ws);
    const result = transport.mutation("items:add", {});
    const failed = result.catch((error) => error);
    wire.emit(data);
    expect(await failed).toBeInstanceOf(Error);
    expect(wire.ws.closes).toBe(1);
    expect(wire.listeners.size).toBe(0);
    await expect(transport.query("items:list", {})).rejects.toThrow();
  }
});

// A full browser socket buffer must not accumulate another request or leave an
// unresolved Promise; both earlier and newly failing mutations terminate.
test("WebSocket SDK fails connection on backpressure and refuses unopened sockets", async () => {
  const wire = socket();
  wire.ws.readyState = 0;
  expect(() => new WebSocketTransport(wire.ws)).toThrow("open");
  wire.ws.readyState = 1;
  const transport = new WebSocketTransport(wire.ws);
  const first = transport.mutation("items:add", {});
  const failed = first.catch((error) => error);
  wire.ws.bufferedAmount = 1024 * 1024 + 1;
  await expect(transport.mutation("items:add", {})).rejects.toThrow("capacity");
  expect((await failed).message).toContain("capacity");
  expect(wire.ws.sent).toHaveLength(1);
  expect(wire.ws.closes).toBe(1);
});
