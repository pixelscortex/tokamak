import type { ChatPort } from "./chat-port";
import type { Id, ArgsOf } from "@tokamak/sdk";
import { api } from "plugin:chat/server";
const TIMEOUT_MS = 30 * 60_000;
type PermissionPart = ArgsOf<typeof api.requestPermission>["part"];
import type { turnBuffer } from "./turn-buffer";

export function permissionPoller(
  chat: ChatPort,
  runId: Id<"runs">,
  token: string,
  buffer: ReturnType<typeof turnBuffer>,
  respond: (requestId: string, optionId: string | null) => Promise<void>,
) {
  const pending = new Map<string, number>();

  return {
    async request(part: PermissionPart) {
      await buffer.update();
      if (!(await chat.requestPermission({ runId, token, part }))) throw new Error("Run cancelled");
      pending.set(part.requestId, Date.now() + TIMEOUT_MS);
    },
    async poll() {
      if (!pending.size) {
        if (!(await chat.runIsRunning({ runId }))) throw new Error("Run cancelled");
        return buffer.maintain();
      }
      const state = await chat.permissionState({ runId });
      for (const [requestId, deadline] of pending) {
        const part = state.parts.find((part) => part.requestId === requestId);
        const expired = Date.now() >= deadline;
        if (state.running && part?.status === "pending" && part.optionId === undefined && !expired) continue;
        if (!state.running) {
          pending.delete(requestId);
          await respond(requestId, null);
          continue;
        }
        let outcome;
        try {
          outcome = await chat.claimPermission({ runId, token, requestId, expired });
        } catch (error) {
          if (await chat.runIsRunning({ runId })) throw error;
          pending.delete(requestId);
          await respond(requestId, null);
          continue;
        }
        if (!outcome) continue;
        pending.delete(requestId);
        await respond(requestId, outcome.optionId);
      }
      if (!state.running) throw new Error("Run cancelled");
      await buffer.maintain();
    },
  };
}
