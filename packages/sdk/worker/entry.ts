// Stdout belongs exclusively to the worker protocol, including during imports.
import { format } from "node:util";
import { pathToFileURL } from "node:url";
import type { FunctionRegistry } from "../src/functions";
import { workerDispatch } from "./dispatch";
import { workerContracts } from "./contracts";
import type { Provider } from "../src/internal/contracts";
import { invocationProcesses } from "./process";
import { WORKER_FRAME_BYTES } from "../src/worker-limits";

const kind = process.env.TOKAMAK_WORKER_LANE ?? "action";
if (kind !== "action" && kind !== "local") throw new Error("Unknown worker lane");
delete process.env.TOKAMAK_WORKER_LANE;
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
const contracts =
  kind === "local" ? workerContracts(root, (path) => import(pathToFileURL(path).href)) : undefined;

let next = 0;
const dispatch = workerDispatch(
  kind,
  functions,
  send,
  () => ++next,
  kind === "local" ? invocationProcesses : undefined,
  contracts,
);

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf(10);
    if (end < 0) break;
    if (end >= WORKER_FRAME_BYTES) throw new Error("Worker message exceeds 1 MiB limit");
    const message = JSON.parse(buffer.subarray(0, end).toString());
    buffer = buffer.subarray(end + 1);
    if (message.type === "shutdown") shutdown();
    else dispatch(message);
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
