import { invokeFunction, type FunctionRegistry } from "../src/functions";
import type { JsonValue } from "../src/values";
import type { HostBridge, HostOperation } from "../src/host";
import { invocationHost } from "./invocation-host";
import { WORKER_CAPACITY } from "../src/worker-limits";
import type { ContractInvocation } from "./contracts";

export type WorkerMessage =
  | { type: "invoke"; id: number; fn: string; args: JsonValue; contract?: ContractInvocation }
  | { type: "opResult"; id: number; value: JsonValue; error?: string }
  | { type: "cancel"; id: number };

export type DispatchOperation = (
  id: number,
  name: HostOperation,
  payload: JsonValue,
  plugin?: string,
  metadata?: { channel: true },
) => Promise<JsonValue>;

type AttachChannel = (
  id: number,
  target: ContractInvocation | undefined,
  signal: AbortSignal,
  operation: DispatchOperation,
) => { bridge: HostBridge["channel"]; dispose(): void };

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
    observeInvocation?: boolean;
    errorMessage(error: unknown): string;
    errorStack?(error: unknown): string | undefined;
    abort(controller: AbortController): void;
    contract?(target: ContractInvocation, args: JsonValue, bridge: HostBridge): Promise<JsonValue>;
    attachChannel?: AttachChannel;
    sendWaiting?(message: object): void | Promise<void>;
  },
) {
  const calls = new Map<
    number,
    {
      controller: AbortController;
      close(): Promise<void>;
      disposeChannel(): void;
    }
  >();
  const pending = new Map<
    number,
    { call: number; resolve(value: JsonValue): void; reject(error: Error): void }
  >();
  const waiting = new Map<number, { call: number; send(): void; reject(error: Error): void }>();
  function transmit(message: object): void | Promise<void> {
    if (options?.sendWaiting) return options.sendWaiting(message);
    send(message);
  }

  function pump() {
    for (const [id, op] of waiting) {
      if (pending.size >= WORKER_CAPACITY) break;
      waiting.delete(id);
      op.send();
    }
  }

  function retire(id: number) {
    calls.get(id)?.disposeChannel();
    calls.delete(id);
    const stale = new Error("stale invocation: host operation refused");
    for (const [key, op] of waiting)
      if (op.call === id) {
        waiting.delete(key);
        op.reject(stale);
      }
    for (const [key, op] of pending)
      if (op.call === id) {
        pending.delete(key);
        op.reject(stale);
      }
    pump();
  }
  async function invoke(id: number, name: string, args: JsonValue, target?: ContractInvocation) {
    if (calls.has(id) || calls.size >= WORKER_CAPACITY)
      throw new Error("Worker invocation capacity exceeded");
    const controller = new AbortController();
    const call = {
      controller,
      close: (): Promise<void> => invocation.close(),
      disposeChannel: () => channel?.dispose(),
    };
    calls.set(id, call);
    function operation(
      op: number,
      name: HostOperation,
      payload: JsonValue,
      plugin?: string,
      metadata?: { channel: true },
    ) {
      if (calls.get(id) !== call || controller.signal.aborted)
        throw new Error("stale invocation: host operation refused");
      const wait = pending.size >= WORKER_CAPACITY;
      if (wait && (!options?.sendWaiting || waiting.size >= WORKER_CAPACITY))
        throw new Error("Worker operation capacity exceeded");
      return new Promise<JsonValue>((resolve, reject) => {
        const dispatch = () => {
          pending.set(op, { call: id, resolve, reject });
          const failed = (error: unknown) => {
            pending.delete(op);
            reject(error);
            pump();
          };
          try {
            const message = {
              type: "op",
              id: op,
              call: id,
              name,
              payload,
              ...(plugin === undefined ? {} : { plugin }),
              ...metadata,
            };
            const sending = transmit(message);
            if (sending) void sending.catch(failed);
          } catch (error) {
            failed(error);
          }
        };
        if (wait) waiting.set(op, { call: id, send: dispatch, reject });
        else dispatch();
      });
    }
    const channel = options?.attachChannel?.(id, target, controller.signal, operation);
    const invocation = invocationHost(
      controller.signal,
      (plugin) => (name, payload) => operation(allocateOp(), name, payload, plugin),
      createPrograms && (() => createPrograms(controller.signal, id)),
      contracts,
      channel?.bridge,
    );
    try {
      if (!(target && options?.contract) && functions[name]?.kind !== kind)
        throw new Error(`Unknown worker ${kind} function: ${name}`);
      const value =
        target && options?.contract
          ? await options.contract(target, args, invocation.host())
          : await invokeFunction(functions, { name, args }, invocation.host());
      await invocation.close();
      if (calls.get(id) === call) {
        const sending = transmit({ type: "result", id, value });
        if (sending) await sending;
      }
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
        const sending = transmit({
          type: "result",
          id,
          error: message,
          ...(stack === undefined ? {} : { stack }),
        });
        if (sending) await sending;
      }
    } finally {
      if (calls.get(id) === call) retire(id);
    }
  }
  return (message: WorkerMessage) => {
    if (message.type === "invoke") {
      const invocation = invoke(message.id, message.fn, message.args, message.contract);
      if (options?.observeInvocation) return invocation;
    } else if (message.type === "opResult") {
      const op = pending.get(message.id);
      pending.delete(message.id);
      if (op) {
        if (typeof message.error === "string") op.reject(new Error(message.error));
        else op.resolve(message.value);
      }
      pump();
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
      if (options) retire(message.id);
    } else throw new Error("Invalid worker message");
  };
}
