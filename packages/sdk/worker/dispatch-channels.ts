import { callHost, type ChannelHandler, type HostBridge } from "../src/host";
import type { JsonValue } from "../src/values";
import { WORKER_CAPACITY } from "../src/worker-limits";
import type { ContractInvocation } from "./contracts";
import type { DispatchOperation } from "./dispatch";
import { wireData } from "./wire-data";

export type PeerMessage = {
  type: "peer";
  id: number;
  call: number;
  channel: number | null;
  payload: { method: string; args: JsonValue };
};

/** Only the QuickJS local entry includes the channel protocol. */
export function dispatchChannels(
  send: (message: object) => void | Promise<void>,
  allocateOp: () => number,
  errorMessage: (error: unknown) => string,
) {
  const active = new Map<number, { signal: AbortSignal; receive?: Promise<ChannelHandler | undefined> }>();
  const outbound = new Map<number, { call: number; handle: ChannelHandler }>();

  return {
    attach(
      call: number,
      target: ContractInvocation | undefined,
      signal: AbortSignal,
      operation: DispatchOperation,
    ) {
      let receiveChannel: (handler?: ChannelHandler) => void = () => {};
      const receive = target?.channel
        ? new Promise<ChannelHandler | undefined>((resolve) => (receiveChannel = resolve))
        : undefined;
      active.set(call, { signal, receive });
      const direct: HostBridge = { op: (name, payload) => operation(allocateOp(), name, payload) };
      const bridge: NonNullable<HostBridge["channel"]> = {
        open(payload, handle) {
          // Leave room for writes, question operations, and fresh invocations.
          const limit = WORKER_CAPACITY / 2;
          if (outbound.size >= limit)
            throw new Error(`Too many turns are running on this machine (${limit}). Wait for one to finish.`);
          const channel = allocateOp();
          const result = operation(channel, "local.contract.call", payload, undefined, { channel: true });
          outbound.set(channel, { call, handle });
          const forget = () => outbound.delete(channel);
          void result.then(forget, forget);
          return {
            result,
            send: (method, args) =>
              callHost(direct, "local.contract.peer", {
                channel,
                method,
                args: wireData(args, "Local contract channel arguments"),
              }),
            async close() {
              if (outbound.has(channel)) await callHost(direct, "local.contract.close", { channel });
            },
            async stopPrograms() {
              if (outbound.has(channel)) await callHost(direct, "local.contract.stopPrograms", { channel });
            },
          };
        },
        receive: receiveChannel,
        send: (method, args) =>
          callHost(direct, "local.contract.peer", {
            method,
            args: wireData(args, "Local contract channel arguments"),
          }),
      };
      return {
        bridge,
        dispose() {
          receiveChannel();
          active.delete(call);
          for (const [channel, owner] of outbound) if (owner.call === call) outbound.delete(channel);
        },
      };
    },
    async receive({ id, call, channel, payload }: PeerMessage) {
      const invocation = active.get(call);
      const linked = channel === null ? undefined : outbound.get(channel);
      const reply = { type: "peerResult", id, call };
      try {
        const handle =
          channel === null ? await invocation?.receive : linked?.call === call ? linked.handle : undefined;
        if (!handle || !invocation || active.get(call) !== invocation || invocation.signal.aborted)
          throw new Error("Local contract channel ended");
        const value = wireData(await handle(payload.method, payload.args), "Local contract channel result");
        if (active.get(call) === invocation) await send({ ...reply, value });
      } catch (error) {
        await send({ ...reply, error: errorMessage(error).slice(0, 8192) });
      }
    },
  };
}
