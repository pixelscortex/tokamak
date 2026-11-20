import { agents, type AgentClient, type AgentEvent } from "../agents/client";
import { sessionModel, type SessionModel } from "../agents/session-model";
import type { ActionSignal, Id } from "@tokamak/sdk";
import type { ChatPort } from "./chat-port";

import { turnBuffer } from "./turn-buffer";
import { readAcpTurn } from "./acp-turn";

const HISTORY_BYTES = 32 * 1024;

type HistoryRecord = { role: string; agent?: string; model?: string; effort?: string; content: string };

// "assistant (Claude, model Opus 5.5 (opus), effort High)"
function speaker(message: HistoryRecord) {
  const about = [
    message.agent,
    message.model && `model ${message.model}`,
    message.effort && `effort ${message.effort}`,
  ].filter(Boolean);
  return about.length ? `${message.role} (${about.join(", ")})` : message.role;
}

// Keep the most recent whole messages within the byte budget, so every kept reply
// keeps its "role (agent, model, effort):" label. Only a single newest message
// larger than the budget is cut, from its start, without splitting Unicode.
export function historyPrefix(history: HistoryRecord[]): string {
  const lines = history.map((message) => `${speaker(message)}: ${message.content}`);
  const kept: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const size = Buffer.byteLength(lines[index]!, "utf8") + (kept.length ? 2 : 0);
    if (bytes + size > HISTORY_BYTES) {
      if (!kept.length) kept.push(tail(lines[index]!, HISTORY_BYTES));
      break;
    }
    bytes += size;
    kept.push(lines[index]!);
  }
  return kept.reverse().join("\n\n");
}

function tail(text: string, budget: number) {
  const characters = Array.from(text);
  let start = characters.length;
  while (start > 0) {
    const point = characters[start - 1]!.codePointAt(0)!;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (size > budget) break;
    budget -= size;
    start--;
  }
  return characters.slice(start).join("");
}

// Pass events through, noting model or effort changes the agent reports mid-turn.
async function* watchModel(
  events: AsyncIterable<AgentEvent>,
  changed: (model: SessionModel) => Promise<void>,
): AsyncIterable<AgentEvent> {
  for await (const event of events) {
    if (event.type === "update" && event.update.sessionUpdate === "config_option_update") {
      const next = sessionModel(event.update);
      if (next) await changed(next);
    }
    yield event;
  }
}

type Started = {
  runId: Id<"runs">;
  token: string;
  messageId: Id<"messages">;
  history: HistoryRecord[];
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
    // Recording the model is best effort: an older hub without it must not fail the turn.
    let model = opened.model;
    const recordModel = (next: SessionModel) =>
      chat.setReplyModel({ runId, token, model: next }).catch(() => null);
    if (model) await recordModel(model);
    const prefix = prompt !== undefined || opened.restored ? "" : historyPrefix(started.history.slice(0, -1));
    const text =
      prompt ??
      (prefix
        ? `Previous conversation (each assistant reply names the agent, model and effort that wrote it; replies naming another agent or model were not written by you as you are now):\n${prefix}\n\nuser: ${args.text.trim()}`
        : args.text.trim());
    const events = watchModel(
      client.prompt({ agent: backend.agent, sessionId: opened.sessionId, text }),
      async (update) => {
        // An update may carry only some options; keep what it does not mention.
        const next = { ...model, ...update };
        if (JSON.stringify(next) === JSON.stringify(model)) return;
        model = next;
        await recordModel(next);
      },
    );
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
