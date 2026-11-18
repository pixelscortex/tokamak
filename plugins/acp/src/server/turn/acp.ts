import { agents, type AgentClient } from "../agents/client";
import type { ActionSignal, Id } from "@tokamak/sdk";
import type { ChatPort } from "./chat-port";

import { turnBuffer } from "./turn-buffer";
import { readAcpTurn } from "./acp-turn";

// Keep the most recent history within the byte budget, without splitting Unicode.
export function historyPrefix(history: { role: string; content: string }[]): string {
  const text = history.map((message) => `${message.role}: ${message.content}`).join("\n\n");
  const characters = Array.from(text);
  let start = characters.length;
  let bytes = 0;
  while (start > 0) {
    const character = characters[start - 1]!;
    const point = character.codePointAt(0)!;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > 32 * 1024) break;
    bytes += size;
    start--;
  }
  return characters.slice(start).join("");
}

type Started = {
  runId: Id<"runs">;
  token: string;
  messageId: Id<"messages">;
  history: { role: string; content: string }[];
};
type Backend = { agent: string; cwd: string; sessionId?: string };

export async function acpSend(
  chat: ChatPort,
  args: { threadId: Id<"threads">; text: string },
  started: Started,
  backend: Backend,
  client: AgentClient = agents,
  signal?: ActionSignal,
  prompt?: string,
) {
  const { runId, messageId, token } = started;
  const buffer = turnBuffer(chat, runId, token);
  let sessionId: string | undefined;
  let finished = false;
  let closed = false;
  let openingSession = true;
  const finish = async (outcome: "done" | "error" | "cancelled", error?: string) => {
    if (!(await chat.runIsRunning({ runId }))) return { runId, messageId, status: "cancelled" as const };
    return {
      runId,
      messageId,
      status: (await chat.updateRun({
        runId,
        token,
        delta: buffer.pending(),
        outcome,
        ...(error === undefined ? {} : { error }),
      })) as "done" | "error" | "cancelled",
    };
  };

  const cancel = () => {
    if (sessionId) void client.cancel({ agent: backend.agent, sessionId }).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) throw new Error("Plugin action cancelled");
    // Keep ownership of an open that completes after cancellation so it can be cancelled too.
    const opening = client.open(backend).then(async (opened) => {
      sessionId = opened.sessionId;
      if (closed) await client.cancel({ agent: backend.agent, sessionId });
      return opened;
    });
    const opened = await buffer.waitFor(opening);
    openingSession = false;
    await chat.saveBackendState({
      runId,
      token,
      threadId: args.threadId,
      plugin: "acp",
      backendId: backend.agent,
      settings: { cwd: backend.cwd },
      state: { sessionId: opened.sessionId },
    });
    const prefix = prompt !== undefined || opened.restored ? "" : historyPrefix(started.history.slice(0, -1));
    const text =
      prompt ??
      (prefix ? `Previous conversation:\n${prefix}\n\nuser: ${args.text.trim()}` : args.text.trim());
    const events = client.prompt({ agent: backend.agent, sessionId: opened.sessionId, text });
    const stopReason = await readAcpTurn(chat, backend.agent, runId, token, buffer, events, client);
    finished = true;
    if (stopReason === "refusal") return await finish("error", "Agent refused");
    if (stopReason === "cancelled") return await finish("cancelled");
    if (stopReason === "max_tokens" || stopReason === "max_turn_requests")
      buffer.append(
        `\n[Agent stopped: ${stopReason === "max_tokens" ? "token limit" : "turn request limit"}.]`,
      );
    if (!["end_turn", "max_tokens", "max_turn_requests"].includes(stopReason))
      return await finish("error", `Unknown agent stop reason: ${stopReason}`);
    return await finish("done");
  } catch (cause) {
    if (!finished && sessionId) await client.cancel({ agent: backend.agent, sessionId }).catch(() => {});
    const error = cause instanceof Error ? cause.message : String(cause);
    return await finish(
      "error",
      openingSession && /auth|sign.?in|log.?in/i.test(error)
        ? `Sign in to \`${backend.agent}\` in a terminal`
        : error,
    );
  } finally {
    signal?.removeEventListener("abort", cancel);
    buffer.close();
    closed = true;
    if (sessionId && !finished) await client.cancel({ agent: backend.agent, sessionId }).catch(() => {});
  }
}
