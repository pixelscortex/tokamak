import { invokeFunction, type FunctionRegistry } from "../src/functions";
import type { JsonValue } from "../src/values";
import { invocationHost } from "./invocation-host";
import { WORKER_CAPACITY } from "../src/worker-limits";

export type WorkerMessage =
  | { type: "invoke"; id: number; fn: string; args: JsonValue }
  | { type: "opResult"; id: number; value: JsonValue; error?: string }
  | { type: "cancel"; id: number };

export function workerDispatch(
  kind: "local" | "action",
  functions: FunctionRegistry,
  send: (message: object) => void,
  allocateOp: () => number,
  createPrograms?: (signal: AbortSignal) => ReturnType<NonNullable<Parameters<typeof invocationHost>[2]>>,
  contracts?: Parameters<typeof invocationHost>[3],
) {
  const calls = new Map<number, AbortController>();
  const pending = new Map<
    number,
    { call: number; resolve(value: JsonValue): void; reject(error: Error): void }
  >();

  function retire(id: number) {
    calls.delete(id);
    for (const [key, op] of pending)
      if (op.call === id) {
        pending.delete(key);
        op.reject(new Error("stale invocation: host operation refused"));
      }
  }
  async function invoke(id: number, name: string, args: JsonValue) {
    if (calls.has(id) || calls.size >= WORKER_CAPACITY)
      throw new Error("Worker invocation capacity exceeded");
    const controller = new AbortController();
    calls.set(id, controller);
    const invocation = invocationHost(
      controller.signal,
      (plugin) => (name, payload) => {
        if (calls.get(id) !== controller || controller.signal.aborted)
          throw new Error("stale invocation: host operation refused");
        if (pending.size >= WORKER_CAPACITY) throw new Error("Worker operation capacity exceeded");
        return new Promise<JsonValue>((resolve, reject) => {
          const op = allocateOp();
          pending.set(op, { call: id, resolve, reject });
          try {
            send({
              type: "op",
              id: op,
              call: id,
              name,
              payload,
              ...(plugin === undefined ? {} : { plugin }),
            });
          } catch (error) {
            pending.delete(op);
            reject(error);
          }
        });
      },
      createPrograms && (() => createPrograms(controller.signal)),
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
  return (message: WorkerMessage) => {
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
    } else throw new Error("Invalid worker message");
  };
}
