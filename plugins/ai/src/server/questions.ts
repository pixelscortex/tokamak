/// <reference types="node" />
// Permission questions in the local part that runs a turn (used by run.ts).
// Everything here lives in this local part's memory only: a question lives as
// long as the app that asked it, so quitting expires it, and only this local
// part holds the token that lets `turns:answer` clear it.
import { randomBytes, randomUUID } from "node:crypto";
import type { Id, LocalContext } from "@tokamak/sdk";
import type { Access, Answer, Question } from "../contracts";
import { api } from "./_generated/api";

interface Pending {
  readonly questionId: string;
  /** The secret `turns:answer` asks for: no other window, even on this device, can answer. */
  readonly token: string;
  resolve(answer: Answer): void;
}

/** The question each turn waits on, by turn id. */
const waiting = new Map<string, Pending>();

/** Turns whose questions are cancelled (Stop, or the turn's call aborted): every ask answers "cancel". */
const cancelled = new Set<string>();

/**
 * Kinds of question answered "Always allow this session", for the agent
 * session they were given in. A turn that does not carry on that session
 * (a fresh one, or another agent's in between) starts with none.
 */
const allowed = new Map<string, { sessionId?: string; kinds: Set<string> }>();

/** Where a thread's allows are kept: one agent's session in one thread. */
export function sessionKey(threadId: string, agentId: string): string {
  return `${threadId}\u0000${agentId}`;
}

/** The question `questionId` if this local part's turn `turnId` still waits on it. */
export function pendingQuestion(turnId: string, questionId: string): Pending | undefined {
  const pending = waiting.get(turnId);
  return pending?.questionId === questionId ? pending : undefined;
}

/** Hands `answer` to the agent, once: false when the question was answered or cancelled meanwhile. */
export function settle(turnId: string, pending: Pending, answer: Answer): boolean {
  if (waiting.get(turnId) !== pending) return false;
  waiting.delete(turnId);
  pending.resolve(answer);
  return true;
}

/**
 * Cancels the turn's questions in memory: the one waiting now and any it
 * asks later resolve "cancel". Used when the turn's call is aborted, where
 * the server can no longer be reached on its behalf; Stop uses `cancel`
 * from `asking`, which also clears the question on the row.
 */
function cancelQuestions(turnId: string): void {
  cancelled.add(turnId);
  const pending = waiting.get(turnId);
  if (pending) settle(turnId, pending, "cancel");
}

/**
 * `run.ask` for one turn, and `end` for when it is over. Full access approves
 * at once and shows nothing; so does a kind allowed in the session this turn
 * carries on (`carried`). Otherwise the turn waits (`turns:ask`) until the
 * card's answer reaches `settle`, with no time limit. Questions asked at once
 * wait in a queue: the turn shows one at a time.
 */
export function asking(
  ctx: LocalContext,
  turn: { turnId: Id<"turns">; access: Access; session: string; carried: string | undefined },
) {
  const { turnId, access, session, carried } = turn;
  const kept = allowed.get(session);
  const allows = carried !== undefined && kept?.sessionId === carried ? kept : { kinds: new Set<string>() };
  allowed.set(session, allows);
  let current = carried;
  function sessionChanged(sessionId: string | undefined) {
    if (current !== undefined && current !== sessionId) allows.kinds.clear();
    current = sessionId;
  }
  const onAbort = () => cancelQuestions(turnId);
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  async function askNow(question: Question): Promise<Answer> {
    if (ctx.signal.aborted || cancelled.has(turnId)) return "cancel";
    if (access === "full" || allows.kinds.has(question.kind)) return "approve";
    const id = randomUUID();
    const token = randomBytes(32).toString("hex");
    const answered = new Promise<Answer>((resolve) =>
      waiting.set(turnId, { questionId: id, token, resolve }),
    );
    try {
      await ctx.runMutation(api.turns.ask, {
        turnId,
        token,
        question: { id, kind: question.kind, action: question.action, subject: question.subject },
      });
    } catch (cause) {
      waiting.delete(turnId);
      throw cause;
    }
    const answer = await answered;
    if (answer === "approveSession") allows.kinds.add(question.kind);
    return answer;
  }

  let queue: Promise<unknown> = Promise.resolve();
  return {
    /**
     * Stop's hook (`turnControl` calls it before the agent's `onStop`): the
     * waiting question is cleared on the row the way an answer clears it and
     * resolves "cancel"; every later ask resolves "cancel" at once.
     */
    async cancel(): Promise<void> {
      cancelled.add(turnId);
      const pending = waiting.get(turnId);
      if (!pending) return;
      // The row may already be past the question (answered meanwhile); the agent gets "cancel" either way.
      await ctx
        .runMutation(api.turns.answer, { turnId, questionId: pending.questionId, token: pending.token })
        .catch(() => {});
      settle(turnId, pending, "cancel");
      // Let the agent act on "cancel" (its `ask` resumes in microtasks) before Stop calls its
      // `onStop`: a program reading its input in order must get the answer before the interrupt.
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    ask(question: Question): Promise<Answer> {
      const next = queue.then(() => askNow(question));
      queue = next.catch(() => {});
      return next;
    },
    sessionChanged,
    /** The turn ended: its allows belong to the session the agent returned, or to none. */
    end(sessionId: string | undefined): void {
      ctx.signal.removeEventListener("abort", onAbort);
      cancelled.delete(turnId);
      waiting.delete(turnId);
      sessionChanged(sessionId);
      if (sessionId === undefined) allowed.delete(session);
      else allows.sessionId = sessionId;
    },
  };
}
