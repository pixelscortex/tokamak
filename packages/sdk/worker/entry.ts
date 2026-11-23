// Stdout belongs exclusively to the worker protocol, including during imports.
import { format } from "node:util";
import { pathToFileURL } from "node:url";
import { invokeFunction, type FunctionRegistry } from "../src/functions";
import { invocationHost } from "./invocation-host";
import type { JsonValue } from "../src/values";
import { workerContracts } from "./contracts";
import type { Provider } from "../src/internal/contracts";
import { invocationProcesses } from "./process";
import { WORKER_CAPACITY, WORKER_FRAME_BYTES } from "../src/worker-limits";

const kind = process.env.TOKAMAK_WORKER_LANE ?? "action";
if (kind !== "action" && kind !== "local") throw new Error("Unknown worker lane");
delete process.env.TOKAMAK_WORKER_LANE;
const calls = new Map<number, AbortController>();
const pending = new Map<
  number,
  { call: number; resolve(value: JsonValue): void; reject(error: Error): void }
>();
let next = 0;
function send(message: object) {
  const line = JSON.stringify(message) + "\n";
  if (Buffer.byteLength(line) > WORKER_FRAME_BYTES) throw new Error("Worker message exceeds 1 MiB limit");
  if (!process.stdout.write(line) && process.stdout.writableLength > 4 * WORKER_FRAME_BYTES)
    throw new Error("Worker output queue exceeds 4 MiB limit");
}
for (const level of ["log", "info", "warn", "error", "debug"] as const)
  console[level] = (...args: unknown[]) => send({ type: "log", level, text: format(...args).slice(0, 8192) });
const root = (await import(pathToFileURL(process.argv[2]!).href)) as {
  functions: FunctionRegistry;
  contractProviders?: Record<string, Provider<"local">>;
};
const { functions } = root;
const contracts = kind === "local" ? workerContracts(root) : undefined;

function retire(id: number) {
  calls.delete(id);
  for (const [key, op] of pending)
    if (op.call === id) {
      pending.delete(key);
      op.reject(new Error("stale invocation: host operation refused"));
    }
}
async function invoke(id: number, name: string, args: JsonValue) {
  if (calls.has(id) || calls.size >= WORKER_CAPACITY) throw new Error("Worker invocation capacity exceeded");
  const controller = new AbortController();
  calls.set(id, controller);
  const invocation = invocationHost(
    controller.signal,
    (plugin) => (name, payload) => {
      if (!calls.has(id) || controller.signal.aborted)
        throw new Error("stale invocation: host operation refused");
      if (pending.size >= WORKER_CAPACITY) throw new Error("Worker operation capacity exceeded");
      return new Promise<JsonValue>((resolve, reject) => {
        const op = ++next;
        pending.set(op, { call: id, resolve, reject });
        try {
          send({ type: "op", id: op, call: id, name, payload, ...(plugin === undefined ? {} : { plugin }) });
        } catch (error) {
          pending.delete(op);
          reject(error);
        }
      });
    },
    kind === "local" ? () => invocationProcesses(controller.signal) : undefined,
    contracts,
  );
  try {
    if (functions[name]?.kind !== kind) throw new Error(`Unknown worker ${kind} function: ${name}`);
    const value = await invokeFunction(functions, { name, args }, invocation.host());
    await invocation.close();
    send({ type: "result", id, value });
  } catch (error) {
    await invocation.close();
    send({ type: "result", id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    retire(id);
  }
}
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf(10);
    if (end < 0) break;
    if (end >= WORKER_FRAME_BYTES) throw new Error("Worker message exceeds 1 MiB limit");
    const message = JSON.parse(buffer.subarray(0, end).toString());
    buffer = buffer.subarray(end + 1);
    if (message.type === "invoke") void invoke(message.id, message.fn, message.args);
    else if (message.type === "opResult") {
      const op = pending.get(message.id);
      pending.delete(message.id);
      if (op) {
        if (typeof message.error === "string") op.reject(new Error(message.error));
        else op.resolve(message.value);
      }
    } else if (message.type === "cancel") {
      calls.get(message.id)?.abort();
      for (const [id, op] of pending)
        if (op.call === message.id) {
          pending.delete(id);
          op.reject(new Error(`Plugin ${kind} function cancelled`));
        }
    } else if (message.type === "shutdown") shutdown();
    else throw new Error("Invalid worker message");
  }
  if (buffer.length >= WORKER_FRAME_BYTES) throw new Error("Worker message exceeds 1 MiB limit");
});
function shutdown() {
  if (process.platform === "win32") process.exit(0);
  // EOF also covers an abruptly exited server. The worker leads the group.
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(0);
  }
}
process.stdin.on("end", shutdown);
