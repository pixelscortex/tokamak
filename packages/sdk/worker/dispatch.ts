<<<<<<< HEAD
import { RemoteFunctionError, type CallError } from "../src/call-error";
=======
import { Visibility } from "../src/visibility";
>>>>>>> 4ff4e5cd (Resolve action placement on the server and share Runner invocation controls)
import { invokeFunction, type FunctionRegistry } from "../src/functions";
import type { Id, JsonValue } from "../src/values";
import type { ActionSignal, HostBridge, HostOperation } from "../src/host";
import { invocationHost } from "./invocation-host";
import { WORKER_CAPACITY } from "../src/worker-limits";
import { ContractCallError, type ContractInvocation } from "./contracts";

export type WorkerMessage =
  | {
      type: "invoke";
      id: number;
      fn: string;
      args: JsonValue;
      contract?: ContractInvocation;
      routed?: boolean;
      action?: boolean;
      admittedAction?: boolean;
    }
  | {
      type: "opResult";
      id: number;
      value: JsonValue;
      error?: CallError;
      unavailable?: true;
      providerError?: true;
    }
  | { type: "cancel" | "retire"; id: number };

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
  options: {
    createPrograms?: (
      signal: AbortSignal,
      call: number,
    ) => ReturnType<NonNullable<Parameters<typeof invocationHost>[2]>>;
    contracts?: Parameters<typeof invocationHost>[3];
    observeInvocation?: boolean;
    errorMessage(error: unknown): string;
    errorStack?(error: unknown): string | undefined;
    abort(controller: AbortController): void;
    contract?(
      target: ContractInvocation,
      args: JsonValue,
      bridge: HostBridge,
      recordThread: (threadId: Id<"threads">) => void,
    ): Promise<JsonValue>;
    attachChannel?: AttachChannel;
    sendWaiting?(message: object): void | Promise<void>;
  },
) {
  const calls = new Map<
    number,
    {
      controller: AbortController;
      retiring?: AbortController;
      close(): Promise<void>;
      disposeChannel(): void;
    }
  >();
  const pending = new Map<
    number,
    { call: number; resolve(value: JsonValue): void; reject(error: unknown): void }
  >();
  const waiting = new Map<number, { call: number; send(): void; reject(error: Error): void }>();
  function transmit(message: object): void | Promise<void> {
    if (options.sendWaiting) return options.sendWaiting(message);
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
  async function invoke(
    id: number,
    name: string,
    args: JsonValue,
    target?: ContractInvocation,
    routed?: boolean,
    action?: boolean,
    admittedAction?: boolean,
  ) {
    if (calls.has(id) || calls.size >= WORKER_CAPACITY)
      throw new Error("Plugin process invocation capacity exceeded");
    let threadId: Id<"threads"> | undefined;
    const recordThread = (id: Id<"threads">) => {
      threadId ??= id;
    };
    const controller = new AbortController();
    const retiring = routed && !target ? new AbortController() : undefined;
    const call = {
      controller,
      retiring,
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
      signal?: ActionSignal,
    ) {
      if (calls.get(id) !== call || controller.signal.aborted)
        throw new Error("stale invocation: host operation refused");
      if (signal?.aborted) throw new Error("Local contract call cancelled");
      const wait = pending.size >= WORKER_CAPACITY;
      if (wait && (!options.sendWaiting || waiting.size >= WORKER_CAPACITY))
        throw new Error("Plugin process operation capacity exceeded");
      return new Promise<JsonValue>((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener("abort", cancel);
        const rejected = (error: unknown) => {
          cleanup();
          reject(error);
        };
        let sending: void | Promise<void>;
        const cancel = () => {
          const error = new Error("Local contract call cancelled");
          if (waiting.delete(op)) {
            rejected(error);
            return;
          }
          if (!pending.has(op)) return;
          rejected(error);
          const sent = () => {
            // Cancellation rejects immediately but keeps the slot until the Runner
            // consumes the queued work and returns its opResult.
            if (pending.has(op)) send({ type: "opCancel", id: op, call: id });
          };
          // A send blocked on the host's byte budget must precede its cancel.
          // Until then it still occupies a pending slot. If the call ends,
          // the host refuses the stale send and no cancel frame is needed.
          if (sending) void sending.then(sent, () => {}).catch(() => {});
          else sent();
        };
        const dispatch = () => {
          pending.set(op, {
            call: id,
            resolve(value) {
              cleanup();
              resolve(value);
            },
            reject: rejected,
          });
          const failed = (error: unknown) => {
            pending.delete(op);
            rejected(error);
            pump();
          };
          try {
            const message = {
              type: "op",
              id: op,
              call: id,
              name,
              payload,
              ...(signal && { cancellable: true }),
              ...(plugin === undefined ? {} : { plugin }),
              ...metadata,
              ...(name === "auth.current" && threadId !== undefined && { threadId }),
            };
            sending = transmit(message);
            if (sending) void sending.catch(failed);
          } catch (error) {
            failed(error);
          }
        };
        signal?.addEventListener("abort", cancel, { once: true });
        if (wait) waiting.set(op, { call: id, send: dispatch, reject: rejected });
        else dispatch();
      });
    }
    const channel = options.attachChannel?.(id, target, controller.signal, operation);
    const invocation = invocationHost(
      controller.signal,
      (plugin) => (name, payload, signal) =>
        operation(allocateOp(), name, payload, plugin, undefined, signal),
      options.createPrograms && (() => options.createPrograms!(controller.signal, id)),
      options.contracts,
      channel?.bridge,
      retiring?.signal,
    );
    function close() {
      // Stop accepting programs immediately; native ownership keeps reaping
      // them even after the Runner has received the result.
      void invocation.close().catch(() => {});
    }
    try {
      if (
        !(target && options.contract) &&
        (functions[name]?.kind !== (action && kind === "local" ? "action" : kind) ||
          (action &&
            kind === "local" &&
            functions[name]?.visibility !== Visibility.Public &&
            !admittedAction))
      )
        throw new Error(`Unknown local ${kind} function: ${name}`);
      const value =
        target && options.contract
          ? await options.contract(target, args, invocation.host(), recordThread)
          : await invokeFunction(
              functions,
              { name, args },
              invocation.host(),
              kind === "local" ? recordThread : undefined,
            );
      close();
      if (calls.get(id) === call) {
        const sending = transmit({ type: "result", id, value });
        if (sending) await sending;
      }
    } catch (error) {
      close();
      const message = options.errorMessage(error);
      if (calls.get(id) === call) {
        let stack: string | undefined;
        try {
          stack = options.errorStack?.(error);
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
      const invocation = invoke(
        message.id,
        message.fn,
        message.args,
        message.contract,
        message.routed,
        message.action,
        message.admittedAction,
      );
      if (options.observeInvocation) return invocation;
    } else if (message.type === "opResult") {
      const op = pending.get(message.id);
      pending.delete(message.id);
      if (op) {
        if (message.error !== undefined) {
          const { error, unavailable, providerError } = message;
          op.reject(
            typeof error === "string" && (unavailable || providerError)
              ? new ContractCallError(error, unavailable === true, providerError === true)
              : new RemoteFunctionError(error),
          );
        } else op.resolve(message.value);
      }
      pump();
    } else if (message.type === "retire") {
      const retiring = calls.get(message.id)?.retiring;
      if (retiring) options.abort(retiring);
    } else if (message.type === "cancel") {
      const call = calls.get(message.id);
      if (call) {
        options.abort(call.controller);
        // Abort listeners can throw in LLRT. Always close every scope.
        void call.close();
      }
      for (const [id, op] of pending)
        if (op.call === message.id) {
          pending.delete(id);
          op.reject(new Error(`Plugin ${kind} function cancelled`));
        }
      retire(message.id);
    } else throw new Error("Invalid plugin process message");
  };
}
