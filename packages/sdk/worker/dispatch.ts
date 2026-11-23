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
  createPrograms?: (
    signal: AbortSignal,
    call: number,
  ) => ReturnType<NonNullable<Parameters<typeof invocationHost>[2]>>,
  contracts?: Parameters<typeof invocationHost>[3],
  options?: {
    errorMessage(error: unknown): string;
    errorStack?(error: unknown): string | undefined;
    abort(controller: AbortController): void;
  },
) {
  const calls = new Map<number, { controller: AbortController; close(): Promise<void> }>();
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
    const call = { controller, close: (): Promise<void> => invocation.close() };
    calls.set(id, call);
    const invocation = invocationHost(
      controller.signal,
      (plugin) => (name, payload) => {
        if (calls.get(id) !== call || controller.signal.aborted)
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
      createPrograms && (() => createPrograms(controller.signal, id)),
      contracts,
    );
    try {
      if (functions[name]?.kind !== kind) throw new Error(`Unknown worker ${kind} function: ${name}`);
      const value = await invokeFunction(functions, { name, args }, invocation.host());
      await invocation.close();
      if (calls.get(id) === call) send({ type: "result", id, value });
    } catch (error) {
      await invocation.close();
      const message =
        options?.errorMessage(error) ?? (error instanceof Error ? error.message : String(error));
      if (calls.get(id) === call) {
        let stack: string | undefined;
        try {
          stack = options?.errorStack?.(error);
        } catch {
          // Error properties may have user-defined getters.
        }
        send({ type: "result", id, error: message, ...(stack === undefined ? {} : { stack }) });
      }
    } finally {
      if (calls.get(id) === call) retire(id);
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
      const call = calls.get(message.id);
      if (call) {
        if (options) {
          options.abort(call.controller);
          // Abort listeners can throw in LLRT. Always close every scope.
          void call.close();
        } else call.controller.abort();
      }
      for (const [id, op] of pending)
        if (op.call === message.id) {
          pending.delete(id);
          op.reject(new Error(`Plugin ${kind} function cancelled`));
        }
      if (options) calls.delete(message.id);
    } else throw new Error("Invalid worker message");
  };
}
