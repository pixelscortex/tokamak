import { WORKER_DATA_BYTES } from "./worker-limits";
import { jsonBytes } from "./agent-reports";

/** Full access (never asks) or Ask first: the agent row's Permission level picker. */
export type Access = "full" | "ask";

/** One earlier message of the thread, as a fresh session is given it. */
export interface HistoryMessage {
  /**
   * "user" for a person, "agent" for any agent's reply (this one or another),
   * "note" for Tokamak's own line, e.g. that the oldest messages are left out.
   */
  readonly role: "user" | "agent" | "note";
  /** Who wrote it as the thread shows it: "Sam", "Claude", "Tokamak". */
  readonly name: string;
  /** Its full text, without command output. */
  readonly text: string;
}

/**
 * A permission question an agent asks on Ask first. The window shows it on the
 * composer as "Claude wants to {action} `{subject}`".
 */
export interface Question {
  /**
   * What "Always allow this session" covers: after that answer, a question of
   * the same kind in this thread's session with this agent is approved without
   * asking, until the app quits. The agent picks it ("command:git push", "edit").
   */
  readonly kind: string;
  /** The verb: "run", "edit", "fetch". */
  readonly action: string;
  /** What it acts on, shown as code: "git push origin feat/csv-export". */
  readonly subject: string;
}

/** The four answers to a question. Each agent plugin translates them for its own program. */
export type Answer = "approve" | "approveSession" | "decline" | "cancel";

/** The turn transport distinguishes Stop from a person answering Cancel on the card. */
export type TurnAnswer = Answer | "stopping";
export const ASK_FOR_TURN = Symbol.for("tokamak.agentTurn.ask");

export type TurnRun = Run & {
  [ASK_FOR_TURN](question: Question): Promise<TurnAnswer>;
};

export function askForTurn(run: Run, question: Question): Promise<TurnAnswer> {
  return (run as Partial<TurnRun>)[ASK_FOR_TURN]?.(question) ?? run.ask(question);
}

export function permissionAnswer(answer: TurnAnswer): Answer {
  return answer === "stopping" ? "cancel" : answer;
}

/** Where a step or a helper agent is. `ai` closes any still running when the turn ends. */
export type StepState = "running" | "done" | "failed";

/**
 * One step of the agent's work (a tool call), as a row under the actions line.
 * Report it when it starts and again, with the same `id`, whenever it changes:
 * the latest report wins. `ai` times it; agents send no times. Only the main
 * agent's own steps: steps a helper agent takes inside itself are not
 * reported in milestone 1 (Claude: skip tool uses with a `parent_tool_use_id`).
 */
export interface Tool {
  /**
   * The program's own id for the call (Claude's `tool_use` id, a Codex item
   * id). One Codex `fileChange` item touching several files is one step per
   * file, with the id `${itemId}:${path}`.
   */
  readonly id: string;
  /** Picks the row's icon and the running line's verb ("Running", "Reading", …). */
  readonly kind: "command" | "read" | "edit" | "search" | "web" | "other";
  /** What the row shows: the command line, the path, the pattern, the URL, or the tool's name. */
  readonly title: string;
  /** A short fact on the right ("+6 −2", "4" matches); without it the row shows the step's time. */
  readonly detail?: string;
  readonly state: StepState;
}

/** One item of the agent's to-do list, shown as "Tasks". */
export interface Task {
  readonly text: string;
  readonly state: "pending" | "running" | "done";
}

/**
 * One built-in helper agent the agent started (Claude's Task agents, Codex's
 * sub-agents), drawn as one folded row. Reported like a `Tool`.
 */
export interface Helper {
  readonly id: string;
  /** The helper's kind as its program names it ("Explore"). */
  readonly name: string;
  /** What it was asked to do. */
  readonly title: string;
  readonly state: StepState;
  /** Its answer, once it has one; the folded row opens to it. */
  readonly text?: string;
}

/**
 * What THIS turn has cost so far. A program that counts for the whole thread
 * (Codex's `tokenUsage.total`) reports the difference from before the turn.
 */
export interface Usage {
  /** Every input token of the turn, cache reads included. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The part of `inputTokens` read from the program's cache, when it reports it. */
  readonly cachedInputTokens?: number;
  /** In US dollars, when the program reports a price. */
  readonly costUsd?: number;
}

/**
 * One turn, handed to the agent's `start` on the sender's own computer. The
 * agent reports into it; `ai` writes every row. A malformed report (an
 * unknown kind or state, an empty id, a negative count) throws from the
 * method, back to the agent.
 */
export interface Run {
  /** The thread's folder on this computer; the agent works here, in place. */
  readonly folder: string;
  /** The person's message exactly as stored in the thread. */
  readonly prompt: string;
  readonly model: string;
  /** The level, when the model offers levels. */
  readonly effort?: string;
  /** The speed, when the agent offers speeds. */
  readonly speed?: string;
  /** The mode, when the agent offers modes. */
  readonly mode?: string;
  readonly access: Access;
  /**
   * The agent's own session to carry on: given when the thread's last turn was
   * this agent's, on this computer. The agent checks it still has it.
   */
  readonly sessionId?: string;
  /**
   * The full text of every earlier message in the thread, oldest first (the
   * person's and every agent's, without command output). Give it to a fresh
   * session: when there is no `sessionId`, or the session is gone. The thread
   * in the database is the truth, so switching agent in a thread works too.
   * A very long thread gives only its newest messages, with a note when
   * available. QuickJS may trim more history to keep the full prompt.
   */
  readonly history: readonly HistoryMessage[];
  /** Adds `delta` to the reply's text, which streams into the thread. */
  text(delta: string): void;
  /**
   * Adds `delta` to the turn's thinking, shown folded above the reply, exactly
   * as given: between two separate thinking blocks the agent sends "\n\n".
   */
  thinking(delta: string): void;
  /** Reports one step; report it again with the same id on every change. */
  tool(tool: Tool): void;
  /** Reports the whole to-do list; each call replaces the last. */
  tasks(tasks: readonly Task[]): void;
  /** Reports a proposed plan as Markdown, shown as a card; each call replaces the last. */
  plan(text: string): void;
  /** Reports one built-in helper agent; report it again with the same id on every change. */
  helper(helper: Helper): void;
  /** Reports the turn's totals so far; each call replaces the last. */
  usage(usage: Usage): void;
  /**
   * Asks the sender before doing something and resolves with their answer.
   * On Full access it resolves "approve" at once and nothing is shown. On
   * Ask first the turn waits, with no time limit, until the sender answers on
   * the card in the window; when the app quits the question expires with it.
   * "cancel" asks the agent to stop the turn. Return `stopped` if it does.
   */
  ask(question: Question): Promise<Answer>;
  /** Call as soon as a requested session fails or changes, before asking in its replacement. */
  sessionChanged(sessionId: string | undefined): void;
  /** Registers how the agent receives another message during this turn. */
  onSteer(handler: (text: string) => void | Promise<void>): void;
  /** Registers a graceful interrupt; the turn ends once start settles. */
  onStop(handler: () => void | Promise<void>): void;
}

/** How the agent ended and which session the next turn can carry on. */
export interface TurnResult {
  readonly sessionId: string;
  /** Set only if the agent confirms an interruption; omit if it completes normally. */
  readonly stopped?: true;
}

/** Each turn message names the thread and its currently running turn. */
export interface TurnAddress {
  readonly threadId: string;
  readonly turnId: string;
}

export type AgentTurnStart = TurnAddress &
  Pick<Run, "folder" | "prompt" | "history" | "sessionId" | "model" | "effort" | "speed" | "mode" | "access">;

/** Bump on incompatible changes to the messages understood by the embedded local host. */
export const AGENT_TURN_PROTOCOL = 2;
export const TURN_ENDED = "This turn has ended";
export type AgentTurnOpen = AgentTurnStart & { version: number };

/** The history notice shared by Chat and the local turn transport. */
export function omittedHistoryNote(count: number): HistoryMessage {
  return {
    role: "note",
    name: "Tokamak",
    text: `${count} earlier ${count === 1 ? "message" : "messages"} of this thread ${count === 1 ? "is" : "are"} left out.`,
  };
}

/** Keep the newest history that fits beside the complete prompt. */
export function agentTurnHistory(start: AgentTurnStart): Run["history"] | undefined {
  const budget = WORKER_DATA_BYTES - jsonBytes([{ ...start, history: [], version: AGENT_TURN_PROTOCOL }]);
  if (budget < 0) return undefined;
  const { history } = start;
  const omitted = omissionCount(history[0]);
  const oldest = omitted ? 1 : 0;
  let rowsBytes = 0;
  let fitting: { first: number; note: HistoryMessage | undefined } | undefined;
  for (let first = history.length; first >= oldest && rowsBytes <= budget; first--) {
    const count = omitted + first - oldest;
    const note = count ? omittedHistoryNote(count) : undefined;
    const noteBytes = note ? jsonBytes(note) + (first < history.length ? 1 : 0) : 0;
    if (rowsBytes + noteBytes <= budget) fitting = { first, note };
    if (first > oldest) rowsBytes += jsonBytes(history[first - 1]) + (first < history.length ? 1 : 0);
  }
  // A prompt that leaves no space even for a note still starts, without history.
  if (!fitting) return [];
  const rows = history.slice(fitting.first);
  return fitting.note ? [fitting.note, ...rows] : rows;
}

function omissionCount(leading: HistoryMessage | undefined): number {
  if (leading?.role !== "note" || leading.name !== "Tokamak") return 0;
  const count = Number(/^([1-9][0-9]*) earlier /.exec(leading.text)?.[1]);
  return Number.isSafeInteger(count) && leading.text === omittedHistoryNote(count).text ? count : 0;
}

type ReportMethods = Pick<Run, "text" | "thinking" | "tool" | "tasks" | "plan" | "helper" | "usage">;

export type AgentTurnEvent =
  | { [K in keyof ReportMethods]: { kind: K; value: Parameters<ReportMethods[K]>[0] } }[keyof ReportMethods]
  | { kind: "session"; value: string | null }
  | { kind: "steerReady" };

export type AgentTurnReport = TurnAddress & { events: AgentTurnEvent[] };
export type AgentTurnAsk = TurnAddress & { question: Question };
export type AgentTurnSteer = TurnAddress & { text: string };

export * from "./agent-reports";
export { hasLocalChannel, localProviders, openLocalChannel } from "./internal/contracts";
