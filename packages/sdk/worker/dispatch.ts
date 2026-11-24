import { invokeFunction, type FunctionRegistry } from "../src/functions";
import type { JsonValue } from "../src/values";
import { callHost, type ChannelHandler, type HostBridge, type HostOperation } from "../src/host";
import { invocationHost } from "./invocation-host";
import { WORKER_CAPACITY } from "../src/worker-limits";
import type { ContractInvocation } from "./contracts";
import { wireData } from "./wire-data";

export type WorkerMessage =
  | { type: "invoke"; id: number; fn: string; args: JsonValue; contract?: ContractInvocation }
  | { type: "opResult"; id: number; value: JsonValue; error?: string }
  | {
      type: "peer";
      id: number;
      call: number;
      channel: number | null;
      payload: { method: string; args: JsonValue };
    }
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
    observeInvocation?: boolean;
    errorMessage(error: unknown): string;
    errorStack?(error: unknown): string | undefined;
    abort(controller: AbortController): void;
    contract?(target: ContractInvocation, args: JsonValue, bridge: HostBridge): Promise<JsonValue>;
  },
) {
  const calls = new Map<
    number,
    {
      controller: AbortController;
      close(): Promise<void>;
      receive?: Promise<ChannelHandler | undefined>;
      endChannel(): void;
    }
  >();
  const pending = new Map<
    number,
    { call: number; resolve(value: JsonValue): void; reject(error: Error): void; receive?: ChannelHandler }
  >();

  function retire(id: number) {
    calls.get(id)?.endChannel();
    calls.delete(id);
    for (const [key, op] of pending)
      if (op.call === id) {
        pending.delete(key);
        op.reject(new Error("stale invocation: host operation refused"));
      }
  }
  async function invoke(id: number, name: string, args: JsonValue, target?: ContractInvocation) {
    if (calls.has(id) || calls.size >= WORKER_CAPACITY)
      throw new Error("Worker invocation capacity exceeded");
    const controller = new AbortController();
    let receiveChannel: (handler?: ChannelHandler) => void = () => {};
    const receive = target?.channel
      ? new Promise<ChannelHandler | undefined>((resolve) => (receiveChannel = resolve))
      : undefined;
    const call = {
      controller,
      close: (): Promise<void> => invocation.close(),
      receive,
      endChannel: () => receiveChannel(),
    };
    calls.set(id, call);
    function operation(
      op: number,
      name: HostOperation,
      payload: JsonValue,
      plugin?: string,
      receive?: ChannelHandler,
    ) {
      if (calls.get(id) !== call || controller.signal.aborted)
        throw new Error("stale invocation: host operation refused");
      if (pending.size >= WORKER_CAPACITY) throw new Error("Worker operation capacity exceeded");
      return new Promise<JsonValue>((resolve, reject) => {
        pending.set(op, { call: id, resolve, reject, receive });
        try {
          send({
            type: "op",
            id: op,
            call: id,
            name,
            payload,
            ...(plugin === undefined ? {} : { plugin }),
            ...(receive === undefined ? {} : { channel: true }),
          });
        } catch (error) {
          pending.delete(op);
          reject(error);
        }
      });
    }
    const direct: HostBridge = { op: (name, payload) => operation(allocateOp(), name, payload) };
    const invocation = invocationHost(
      controller.signal,
      (plugin) => (name, payload) => operation(allocateOp(), name, payload, plugin),
      createPrograms && (() => createPrograms(controller.signal, id)),
      contracts,
      options?.contract && {
        open(payload, handler) {
          // Leave room for writes, question operations, and fresh invocations.
          let linked = 0;
          for (const op of pending.values()) if (op.receive) linked++;
          if (linked >= WORKER_CAPACITY / 4)
            throw new Error("Active local contract channel capacity exceeded");
          const channel = allocateOp();
          const result = operation(channel, "local.contract.call", payload, undefined, handler);
          return {
            result,
            send: (method, args) =>
              callHost(direct, "local.contract.peer", {
                channel,
                method,
                args: wireData(args, "Local contract channel arguments"),
              }),
            async close() {
              if (pending.has(channel)) await callHost(direct, "local.contract.close", { channel });
            },
          };
        },
        receive: receiveChannel,
        send: (method, args) =>
          callHost(direct, "local.contract.peer", {
            method,
            args: wireData(args, "Local contract channel arguments"),
          }),
      },
    );
    try {
      if (!(target && options?.contract) && functions[name]?.kind !== kind)
        throw new Error(`Unknown worker ${kind} function: ${name}`);
      const value =
        target && options?.contract
          ? await options.contract(target, args, invocation.host())
          : await invokeFunction(functions, { name, args }, invocation.host());
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
  async function peer(message: Extract<WorkerMessage, { type: "peer" }>) {
    const { id, call, channel, payload } = message;
    const active = calls.get(call);
    const outbound = channel === null ? undefined : pending.get(channel);
    const reply = { type: "peerResult", id, call };
    try {
      const handle =
        channel === null ? await active?.receive : outbound?.call === call ? outbound.receive : undefined;
      if (!handle || !active || calls.get(call) !== active || active.controller.signal.aborted)
        throw new Error("Local contract channel ended");
      const value = wireData(await handle(payload.method, payload.args), "Local contract channel result");
      if (calls.get(call) === active) send({ ...reply, value });
    } catch (error) {
      send({ ...reply, error: (options?.errorMessage(error) ?? String(error)).slice(0, 8192) });
    }
  }
  return (message: WorkerMessage) => {
    if (message.type === "invoke") {
      const invocation = invoke(message.id, message.fn, message.args, message.contract);
      if (options?.observeInvocation) return invocation;
    } else if (message.type === "peer" && options?.contract) {
      void peer(message).catch(() => {});
    } else if (message.type === "opResult") {
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
      if (options) retire(message.id);
    } else throw new Error("Invalid worker message");
  };
}
