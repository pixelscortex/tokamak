import { contract, type Failure, type Id, type JsonValue, type LocalContext } from "@tokamak/sdk";

/**
 * What an agent plugin (`claude`, `codex`, a test fake) tells the agent row,
 * in one answer because the pickers need it together. Asked again every time
 * the row looks, so a fresh install or sign-in shows without a restart.
 */
export interface Info {
  readonly installed: boolean;
  readonly signedIn: boolean;
  /** A user-facing reason when the installed program needs an update. */
  readonly updateRequired?: string;
  /** The command that installs the agent's program; kept for a later one-click install. */
  readonly install: string;
  /** The command that signs the program in. */
  readonly signIn: string;
  /**
   * The first model is the default. A model's `efforts` are the agent row's
   * Level picker (e.g. "low", "high").
   */
  readonly models: readonly {
    readonly id: string;
    /**
     * As people see it, without the agent's name: "Fable 5.2", not "Claude
     * Fable 5.2". The window drops a leading agent name anyway.
     */
    readonly name: string;
    readonly efforts: readonly string[];
    /** This model's own mark, when it differs from the agent's `icon`; same format. */
    readonly icon?: string;
  }[];
  /** The agent row's Speed picker (e.g. "standard", "fast"). */
  readonly speeds: readonly string[];
  /**
   * The agent row's Mode picker, a way of working other than speed (e.g.
   * Codex's "default" and "plan"). Most agents offer none.
   */
  readonly modes: readonly string[];
  // For efforts, speeds and modes alike: the first is the default, and an
  // empty list hides that picker.
}

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
   * A very long thread gives only its newest messages, after a first "note"
   * saying how many were left out.
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

export interface Agent {
  /** Stable id, recorded on each turn ("claude", "codex"). */
  readonly id: string;
  /** What a person sees: "Claude", "Codex". No persona names. */
  readonly name: string;
  /**
   * The agent's mark, shown in the agent row, above its replies and in the
   * thread list: an SVG document with a 24 × 24 viewBox whose paths are
   * painted in `currentColor` (the LobeHub mono icons are this shape). Only
   * the paths' outlines are drawn. Without one, a neutral mark stands in.
   */
  readonly icon?: string;
  info(): Promise<Info>;
  /** Runs one turn to its end and reports its outcome. */
  start(run: Run): Promise<TurnResult>;
}

/**
 * The agent contract. Agent plugins provide it from their `local` code:
 *
 * ```ts
 * import * as ai from "plugin:ai/contracts";
 * const info = local({ handler: async (ctx): Promise<ai.Info> => ({ ... }) });
 * const start = local({ handler: async (ctx, run: ai.Run) => { run.text("Hi"); return { sessionId } } });
 * export default provide(ai.agent, { id: "codex", name: "Codex", info, start });
 * ```
 */
export const agent = contract<Agent>("agent", { place: "local", dataMethods: ["info"] });

/** Plain data sent to a provider for both phases of a turn. */
export interface TurnDetails {
  readonly threadId: Id<"threads">;
  readonly turnId: string;
  readonly folder: string;
  /** Only after receives the state returned by this provider's before hook. */
  readonly before?: JsonValue;
}

/** Use SDK `localHook` to receive the invocation signal in the provider. */
export interface TurnInfo extends TurnDetails {
  /** Aborted when this hook is cancelled; use it to stop work. */
  readonly signal: LocalContext["signal"];
}

export interface TurnHooks {
  /** Runs before the agent starts. A failure, exception or timeout prevents the agent from starting. */
  before?(turn: TurnDetails): Promise<void | Failure<string, JsonValue> | { state: JsonValue }>;
  /** Runs after the agent settles. Errors and timeouts are notices; they never change its outcome. */
  after?(turn: TurnDetails): Promise<void>;
}

/** Local hooks around a turn, called with a 60-second limit before the thread is freed. */
export const turnHooks = contract<TurnHooks>("turnHooks", { place: "local", dataMethods: true });
