// Stdout belongs exclusively to the worker protocol, including during imports.
import { realpathSync, writeSync } from "node:fs";
import { SourceMap } from "node:module";
import { format } from "node:util";
import { pathToFileURL } from "node:url";
import { invokeFunction, type FunctionRegistry } from "../src/functions";
import type { HostBridge } from "../src/host";
import type { JsonValue } from "../src/values";

const LIMIT = 1024 * 1024;
const calls = new Map<number, AbortController>();
const pending = new Map<
  number,
  { call: number; resolve(value: JsonValue): void; reject(error: Error): void }
>();
let next = 0;
const stdoutReady = new Int32Array(new SharedArrayBuffer(4));
function send(message: object) {
  const line = Buffer.from(JSON.stringify(message) + "\n");
  if (line.length > LIMIT) throw new Error("Worker message exceeds 1 MiB limit");
  // Block the worker on a full pipe. The server drains it independently, and
  // writing all frames this way keeps console output ahead of invocation replies.
  for (let offset = 0; offset < line.length;) {
    try {
      offset += writeSync(1, line, offset, line.length - offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN" && code !== "EWOULDBLOCK" && code !== "EINTR") throw error;
      Atomics.wait(stdoutReady, 0, 0, 1);
    }
  }
}
function boundedText(text: string, limit: number) {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return bytes.toString();
  const marker = " [truncated]";
  let end = limit - marker.length;
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString() + marker;
}

for (const level of ["log", "info", "warn", "error", "debug"] as const)
  console[level] = (...args: unknown[]) =>
    send({ type: "log", level, text: boundedText(format(...args), 8192) });
const workerPath = realpathSync(process.argv[2]!);
const { functions, workerSourceMap } = (await import(pathToFileURL(workerPath).href)) as {
  functions: FunctionRegistry;
  workerSourceMap?: ConstructorParameters<typeof SourceMap>[0];
};
const sourceMap = workerSourceMap && new SourceMap(workerSourceMap);

function mapFrame(frame: string) {
  return frame.replace(/(.+):(\d+):(\d+)(\)?$)/, (match, prefix: string, line, column, tail) => {
    if (!sourceMap || !prefix.endsWith(workerPath)) return match;
    const entry = sourceMap.findEntry(Number(line) - 1, Number(column) - 1);
    if (!("originalSource" in entry)) return match;
    return (
      prefix.slice(0, -workerPath.length) +
      `${entry.originalSource}:${entry.originalLine + 1}:${entry.originalColumn + 1}${tail}`
    );
  });
}

function retire(id: number) {
  calls.delete(id);
  for (const [key, op] of pending)
    if (op.call === id) {
      pending.delete(key);
      op.reject(new Error("stale invocation: host operation refused"));
    }
}
async function invoke(id: number, name: string, args: JsonValue) {
  if (calls.has(id) || calls.size >= 128) throw new Error("Worker invocation capacity exceeded");
  const controller = new AbortController();
  calls.set(id, controller);
  const host: HostBridge = {
    signal: controller.signal,
    op(name, payload) {
      if (!calls.has(id) || controller.signal.aborted)
        throw new Error("stale invocation: host operation refused");
      if (pending.size >= 128) throw new Error("Worker operation capacity exceeded");
      return new Promise<JsonValue>((resolve, reject) => {
        const op = ++next;
        pending.set(op, { call: id, resolve, reject });
        try {
          send({ type: "op", id: op, call: id, name, payload });
        } catch (error) {
          pending.delete(op);
          reject(error);
        }
      });
    },
  };
  try {
    if (functions[name]?.kind !== "action") throw new Error(`Unknown worker action: ${name}`);
    const value = await invokeFunction(functions, { name, args }, host);
    send({ type: "result", id, value });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack =
      error instanceof Error && typeof error.stack === "string"
        ? error.stack.split("\n", 33).slice(1).map(mapFrame).join("\n")
        : "";
    send({ type: "result", id, error: boundedText(stack ? `${message}\n${stack}` : message, 16 * 1024) });
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
    if (end >= LIMIT) throw new Error("Worker message exceeds 1 MiB limit");
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
          op.reject(new Error("Plugin action cancelled"));
        }
    } else if (message.type === "shutdown") shutdown();
    else throw new Error("Invalid worker message");
  }
  if (buffer.length >= LIMIT) throw new Error("Worker message exceeds 1 MiB limit");
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
