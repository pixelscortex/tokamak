/// <reference types="node" />
import { randomBytes } from "node:crypto";
import { platform } from "node:os";
import {
  fail,
  isFailure,
  action,
  v,
  type ArgsOf,
  type Id,
  type Infer,
  type CallerActionContext,
} from "@tokamak/sdk";
import { hasLocalChannel } from "@tokamak/sdk/agent-turn";
import { agent, type LaunchSettings, type Run, type Usage } from "../contracts";
import { errorText, setupReason } from "../shared/turn-shared";
import { controlFor, noRunningTurn, turnControl } from "./controls";
import { api } from "./_generated/api";
import { offered } from "../shared/offered";
import { infoAfterStartFailure, infoOf } from "./agents";
import { startAgent } from "./agent-turn";
import {
  append,
  check,
  checkedHelper,
  checkedTasks,
  checkedText,
  checkedTool,
  checkedUsage,
  fit,
  jsonBytes,
  PLAN_BYTES,
  TEXT_BYTES,
  WRITE_BYTES,
} from "./limits";
import { asking, pendingQuestion, sessionKey, settle } from "./questions";
import { access, answer as answerValue, type stepReport } from "./schema";
import { keepAlive } from "./keep-alive";
import { hooksFor } from "./turn-hooks";
import { windowKey, workingOn } from "./working";

import { RELOADED } from "../shared/turn-timing";

/**
 * One turn, run on the sender's own computer: begin it (one writer per
 * thread), hand the message to the chosen agent's `start` (with the session to
 * carry on, or the thread's earlier messages for a fresh one), stream what it
 * reports into the reply, and settle it before releasing the thread. The
 * window calls this after each Send with the thread's choices; it returns
 * when the turn has ended.
 */
export const turn = action({
  on: "caller",
  args: {
    windowId: v.string(),
    threadId: v.id("threads"),
    messageId: v.string(),
    replyToken: v.optional(v.string()),
    /** The thread's folder on this computer, from chat's `onSent`. */
    folder: v.string(),
    agentId: v.string(),
    /** The model picked in the agent row; the agent's first model when absent or gone. */
    model: v.optional(v.string()),
    /** The level; the model's first when absent or not offered. */
    effort: v.optional(v.string()),
    /** The speed; the agent's first when absent or not offered. */
    speed: v.optional(v.string()),
    /** The mode; the agent's first when absent or not offered. */
    mode: v.optional(v.string()),
    /** Every thread starts on Full access. */
    access: v.optional(access),
  },
  handler: async (ctx, { windowId, threadId, messageId, replyToken, folder, agentId, access, ...picked }) => {
    const owner = windowKey(ctx.auth, windowId);
    // The labels `turns:begin` records are checked here, against what the provider offers.
    const queued = await ctx.runQuery(api.turns.queuedForMessage, { messageId });
    agentId = queued?.agent.id ?? agentId;
    const provider = await agent.get(agentId, ctx);
    if (!provider) return fail("NoAgent", { agentId });
    const { settings: launchSettings, error: launchError } = await resolveLaunch(ctx);
    // The normal catalog checks the person's own login. An isolated turn
    // instead uses the choices from the window and lets its CLI validate them.
    // A queued turn keeps the settings it was queued with.
    const wanted = queued ?? { ...picked, access };
    let modelName: string | undefined;
    let choices = {
      model: wanted.model ?? "default",
      effort: wanted.effort,
      speed: wanted.speed,
      mode: wanted.mode,
    };
    if (!launchError && !launchSettings) {
      const info = await infoOf(provider, true);
      if (!info.installed)
        return fail("NotInstalled", {
          agent: provider.name,
          ...(info.updateRequired && { updateRequired: info.updateRequired }),
        });
      if (!info.signedIn) return fail("SignedOut", { agent: provider.name });
      const { model, effort, speed, mode } = offered(info, wanted);
      modelName = model?.name;
      choices = { model: model?.id ?? "default", effort, speed, mode };
    }
    const { model, effort, speed, mode } = choices;
    const settings = {
      model,
      ...(effort !== undefined && { effort }),
      ...(speed !== undefined && { speed }),
      ...(mode !== undefined && { mode }),
      access: wanted.access ?? ("full" as const),
    };
    const begun = await ctx.runMutation(api.turns.begin, {
      threadId,
      messageId,
      ...(hasLocalChannel(provider) && { folder }),
      agent: { id: provider.id, name: provider.name },
      ...settings,
      ...(modelName !== undefined && { modelName }),
      replyToken: replyToken ?? randomBytes(32).toString("hex"),
    });
    if (isFailure(begun)) return begun;
    if ("state" in begun) {
      const failed: { turnId: typeof begun.turnId; state: "failed"; hookNotice?: string; ended?: string } =
        begun;
      return failed;
    }
    const { turnId, prompt, history } = begun;
    // Isolated CLI state is discarded at the end; use the thread's history.
    const sessionId = launchSettings ? undefined : begun.sessionId;
    const hooks = hooksFor(ctx, { threadId, turnId, folder });
    const writer = turnWriter(ctx, turnId);
    // The session this turn carries on (`turns:begin`: the thread's last turn was this agent's, on this
    // device), so "Always allow this session" answers hold across turns exactly while the session does.
    const questions = asking(ctx, {
      turnId,
      access: settings.access,
      owner,
      session: sessionKey(owner, threadId, provider.id),
      carried: sessionId,
    });
    // Stop answers a waiting question "cancel" first: an agent may wait for the answer before it stops.
    const control = turnControl(turnId, owner, questions.cancel, hooks.stopBefore);
    // From here until the turn is settled, the server hears from this computer (liveness.ts), and
    // quitting the app asks first (working.ts). Both are released however the turn ends.
    let lost: string | undefined;
    const loseTurn = (reason: string) => {
      if (!control.active) {
        hooks.skipAfter();
        return;
      }
      if (lost !== undefined) return;
      lost = reason;
      hooks.cancel(reason);
      void control.forceStop().catch(() => {});
    };
    const alive = keepAlive(ctx, turnId, loseTurn);
    const reloaded = () => loseTurn(RELOADED);
    ctx.retiring?.addEventListener("abort", reloaded, { once: true });
    if (ctx.retiring?.aborted) reloaded();
    const unregister = workingOn(turnId, {
      owner,
      threadId,
      agent: provider.name,
      control,
      skipAfter: hooks.skipAfter,
    });
    try {
      let ending: Pick<ArgsOf<typeof api.turns.finish>, "state" | "error" | "sessionId">;
      const beforeError = lost ?? launchError ?? (await hooks.before());
      const lostBefore = lost;
      if (lostBefore !== undefined) {
        ending = { state: "interrupted", error: lostBefore };
      } else if (hooks.stoppedBefore) {
        ending = { state: "stopped" };
      } else if (beforeError !== undefined) {
        ending = { state: "failed", error: beforeError };
      } else {
        try {
          // A write the server refused twice: stop the agent's programs now, as Force stop does.
          void writer.broke.then(() => control.forceStop()).catch(() => {});
          const input = {
            folder,
            prompt,
            ...settings,
            history,
            ...(launchSettings && { launchSettings }),
            ...(sessionId === undefined ? {} : { sessionId }),
          };
          const reports = { ...writer.reports, sessionChanged: questions.sessionChanged };
          const result = await startAgent(
            provider,
            { threadId, turnId, ...input },
            reports,
            questions,
            control,
          );
          ending = result
            ? {
                state: result.stopped ? "stopped" : "done",
                ...(!launchSettings && { sessionId: result.sessionId }),
              }
            : { state: "stopped" };
        } catch (cause) {
          const current =
            lost === undefined && !launchSettings ? await infoAfterStartFailure(provider) : undefined;
          ending = {
            state: "failed",
            error: launchSettings
              ? `${provider.name} could not finish the turn with its launch settings.`
              : ((current && setupReason(provider.name, current)) ?? errorText(cause)),
          };
        }
      }
      if (lost !== undefined) ending = { ...ending, state: "interrupted", error: lost };
      // A graceful interruption can still return the session and its existing grants.
      questions.end(ending.sessionId);
      control.finish();
      finishing.set(turnId, owner);
      await writer.settled();
      const broken = writer.close();
      // The turn did not reach the thread whole; the agent's session id is kept when it gave one.
      if (broken !== undefined && lost === undefined)
        ending = { ...ending, state: "failed", error: `Could not save the reply: ${errorText(broken)}` };
      // Force stop only closes the agent's program scope. Run after hooks before releasing the queue.
      const hookNotice =
        launchError || (hooks.stoppedBefore && lostBefore === undefined)
          ? undefined
          : (lostBefore ?? beforeError ?? (lost === undefined ? await hooks.after() : hooks.notice()));
      let state;
      try {
        const acknowledgedSteer = control.acknowledgedSteer();
        state = await ctx.runMutation(api.turns.finish, {
          turnId,
          ...ending,
          finishedAt: Date.now(),
          ...(acknowledgedSteer === undefined ? {} : { acknowledgedSteer }),
        });
      } catch {
        // The server cannot be reached or already ended the turn; the interrupt rule frees the thread.
        // `ended` says why in the person's words when this computer had to stop the agent.
        return {
          turnId,
          state: "failed" as const,
          ...(hookNotice !== undefined && { hookNotice }),
          ...(lost !== undefined && { ended: lost }),
        };
      }
      return {
        turnId,
        state,
        ...(hookNotice !== undefined && { hookNotice }),
        ...(lost !== undefined && { ended: lost }),
      };
    } finally {
      ctx.retiring?.removeEventListener("abort", reloaded);
      control.close();
      finishing.delete(turnId);
      alive.stop();
      unregister();
    }
  },
});

/** Collect a fresh snapshot before even probing the agent's CLI. */
async function resolveLaunch(
  ctx: CallerActionContext,
): Promise<{ settings?: LaunchSettings; error?: string }> {
  try {
    const contributions = await ctx.point(
      "launch",
      { env: {} as Record<string, string>, args: [] as string[] },
      { collect: true },
    );
    const ignoreCase = platform() === "win32";
    const env = new Map<string, { plugin: string; name: string; value: string }>();
    const args: string[] = [];
    for (const { plugin, value } of contributions) {
      // The point validator checks the shape, but leaves index signatures open.
      if (!value.env || typeof value.env !== "object" || Array.isArray(value.env))
        throw new TypeError("Invalid launch environment");
      for (const [name, setting] of Object.entries(value.env)) {
        if (!name || /[=\0\r\n]/.test(name) || typeof setting !== "string" || setting.includes("\0"))
          throw new TypeError("Invalid launch environment entry");
        const key = ignoreCase ? name.toUpperCase() : name;
        const previous = env.get(key);
        if (previous && previous.plugin !== plugin) {
          return {
            error: `Could not start the turn: plugins "${previous.plugin}" and "${plugin}" both set ${name}.`,
          };
        }
        env.set(key, { plugin, name, value: setting });
      }
      for (const arg of value.args) args.push(arg);
    }
    if (!env.size && !args.length) return {};
    return {
      settings: { env: Object.fromEntries([...env.values()].map(({ name, value }) => [name, value])), args },
    };
  } catch {
    // Hook errors can contain the settings the hook was assembling.
    return { error: "Could not prepare the agent's launch settings." };
  }
}

/** Steers on the sender's window, and records the text only once the agent can receive it. */
export const steer = action({
  on: "caller",
  args: { windowId: v.string(), turnId: v.id("turns"), text: v.string() },
  handler: async (ctx, { windowId, turnId, text }) => {
    const control = controlFor(turnId, windowKey(ctx.auth, windowId));
    if (!control) return noRunningTurn(turnId);
    const steerText = text.trim();
    if (!steerText) return fail("EmptySteer", { turnId });
    return control.steer(steerText, (text, delivery) =>
      ctx.runMutation(api.turns.steer, { turnId, text, ...(delivery && { delivery }) }),
    );
  },
});

/** Turns whose agent has settled and whose after hooks are still running. */
const finishing = new Map<string, string>();

/** Marks Stop on the server before asking the provider to end, so its final reply is stopped. */
export const stop = action({
  on: "caller",
  args: { windowId: v.string(), turnId: v.id("turns") },
  handler: async (ctx, { windowId, turnId }) => {
    const control = controlFor(turnId, windowKey(ctx.auth, windowId));
    // The agent has settled and only after hooks remain: nothing is left to stop.
    if (!control || !control.active)
      return finishing.get(turnId) === windowKey(ctx.auth, windowId)
        ? fail("NotRunning", { turnId, finishing: true })
        : noRunningTurn(turnId);
    return (await control.requestStop(() => ctx.runMutation(api.turns.requestStop, { turnId })))
      ? null
      : noRunningTurn(turnId);
  },
});

/** Kills the run's program groups after the deadline recorded on its server row. */
export const forceStop = action({
  on: "caller",
  args: { windowId: v.string(), turnId: v.id("turns") },
  handler: async (ctx, { windowId, turnId }) => {
    const control = controlFor(turnId, windowKey(ctx.auth, windowId));
    if (!control) return noRunningTurn(turnId);
    if ((await ctx.runQuery(api.turns.forceStopDelay, { turnId })) !== 0) return fail("TooEarly", { turnId });
    return control.forceStop();
  },
});

/**
 * The sender's answer to a question waiting in this window. The card on
 * the composer calls this; it fails with `Expired` when no turn here waits on
 * that question, as after the app that asked it quit. `turns:answer` clears
 * the question on the row (checking inside that the caller is the turn's
 * sender on its device, with the token only its Runner holds); only
 * then does the answer reach the agent.
 */
export const answer = action({
  on: "caller",
  args: { windowId: v.string(), turnId: v.id("turns"), questionId: v.string(), answer: answerValue },
  handler: async (ctx, { windowId, turnId, questionId, answer }) => {
    const pending = pendingQuestion(windowKey(ctx.auth, windowId), turnId, questionId);
    if (!pending) return fail("Expired", { turnId });
    await ctx.runMutation(api.turns.answer, { turnId, questionId, token: pending.token });
    // A second click while the first answer was on its way finds nothing left to answer.
    settle(turnId, pending, answer);
    return null;
  },
});

/**
 * Whether this window still owns the question, so the card can say at
 * once that a question from before the app quit has expired.
 */
export const pending = action({
  on: "caller",
  args: { windowId: v.string(), turnId: v.id("turns"), questionId: v.string() },
  handler: async (ctx, { windowId, turnId, questionId }) =>
    pendingQuestion(windowKey(ctx.auth, windowId), turnId, questionId) !== undefined,
});

/** A step as the Runner keeps it: the agent's latest report and when this computer saw it begin and end. */
type StepReport = Infer<typeof stepReport>;
type WriteArgs = ArgsOf<typeof api.turns.write>;
/** The report methods of a `Run`: what the agent calls while it works. */
type Reports = Pick<Run, "text" | "thinking" | "tool" | "tasks" | "plan" | "helper" | "usage">;

/** The reports that replace what is stored: the to-do list, the plan, usage. */
type Latest = { tasks?: WriteArgs["tasks"]; plan?: string; usage?: Usage };

/**
 * What the server has not been sent yet, and how it goes out: each write
 * takes what fits under `WRITE_BYTES`, text and thinking first (cut to fit
 * when they must), and leaves the rest for the next one.
 */
class Unsent {
  /** Text and thinking appended since they were last sent. */
  text = "";
  thinking = "";
  readonly latest: Latest = {};
  readonly dirty = new Set<keyof Latest>();
  /** Every step as last reported, and the keys that changed since they were last sent. */
  readonly steps = new Map<string, StepReport>();
  readonly dirtySteps = new Set<string>();

  /** The whole text and thinking so far, cut at their limits as the server cuts them. */
  readonly whole = { text: "", thinking: "" };

  append(field: "text" | "thinking", delta: string): void {
    const next = append(this.whole[field], delta, TEXT_BYTES);
    this[field] += next.slice(this.whole[field].length);
    this.whole[field] = next;
  }

  /** Keeps a step's latest report, timed on this computer: when its id was first seen and when it ended. */
  step(report: Omit<StepReport, "startedAt" | "finishedAt">): void {
    const now = Date.now();
    const known = this.steps.get(report.key);
    const startedAt = known?.startedAt ?? now;
    const finishedAt = report.state === "running" ? undefined : (known?.finishedAt ?? now);
    this.steps.set(report.key, { ...report, startedAt, ...(finishedAt !== undefined && { finishedAt }) });
    this.dirtySteps.add(report.key);
  }

  any(): boolean {
    return this.text !== "" || this.thinking !== "" || this.dirty.size > 0 || this.dirtySteps.size > 0;
  }

  next(turnId: Id<"turns">): WriteArgs {
    const out: WriteArgs = { turnId };
    let room = WRITE_BYTES - jsonBytes(out);
    const empty = () => Object.keys(out).length === 1;
    if (this.text) {
      out.text = fit(this.text, room - 16);
      this.text = this.text.slice(out.text.length);
      room -= jsonBytes(out.text) + 16;
    }
    if (this.thinking && room > 64) {
      out.thinking = fit(this.thinking, room - 16);
      this.thinking = this.thinking.slice(out.thinking.length);
      room -= jsonBytes(out.thinking) + 16;
    }
    for (const field of this.dirty) {
      const size = jsonBytes(this.latest[field]) + 16;
      if (size > room && !empty()) continue;
      Object.assign(out, { [field]: this.latest[field] });
      this.dirty.delete(field);
      room -= size;
    }
    const changed: StepReport[] = [];
    for (const key of this.dirtySteps) {
      const step = this.steps.get(key)!;
      const size = jsonBytes(step) + 1;
      if (size > room - 16 && (changed.length > 0 || !empty())) break;
      changed.push(step);
      this.dirtySteps.delete(key);
      room -= size;
    }
    if (changed.length > 0) out.steps = changed;
    return out;
  }
}

/**
 * Collects what the agent reports and stores it on the server. At most one
 * write is in flight; each carries what changed since the last (text and
 * thinking as appended deltas, the latest tasks, plan and usage, the changed
 * steps; see `Unsent`). Texts
 * are cut at their limits here as on the server. Steps are timed here, on
 * the computer that runs the turn. A write refused twice breaks the writer:
 * `broke` resolves, and every later report throws back to the agent.
 */
function turnWriter(ctx: CallerActionContext, turnId: Id<"turns">) {
  const unsent = new Unsent();
  let flight: Promise<void> | undefined;
  let broken: unknown;
  let closed = false;
  let onBroken: () => void = () => {};
  const broke = new Promise<undefined>((resolve) => (onBroken = () => resolve(undefined)));

  function pump(): void {
    flight ??= (async () => {
      while (unsent.any() && broken === undefined) {
        const args = unsent.next(turnId);
        // One retry covers a dropped connection; a second refusal means the server will not take it.
        await ctx
          .runMutation(api.turns.write, args)
          .catch(() => ctx.runMutation(api.turns.write, args))
          .catch((cause: unknown) => {
            broken = cause;
            onBroken();
          });
        // Let buffered agent reports arrive before taking the next write, without delaying the first.
        if (broken === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      flight = undefined;
    })();
  }
  function open() {
    check(broken === undefined, `the turn could not be saved: ${errorText(broken)}`);
    check(!closed, "this turn has ended");
  }
  function set<K extends keyof Latest>(field: K, value: Latest[K]) {
    unsent.latest[field] = value;
    unsent.dirty.add(field);
    pump();
  }

  // Each method checks the agent's report (throwing back to the agent) and
  // keeps only the fields the contract names, so extra fields never reach a row.
  const reports: Reports = {
    text(delta) {
      open();
      unsent.append("text", checkedText(delta, "text(delta)"));
      pump();
    },
    thinking(delta) {
      open();
      unsent.append("thinking", checkedText(delta, "thinking(delta)"));
      pump();
    },
    tool(tool) {
      open();
      const { id: key, ...step } = checkedTool(tool);
      unsent.step({ key, type: "tool", ...step });
      pump();
    },
    helper(helper) {
      open();
      const { id: key, ...step } = checkedHelper(helper);
      unsent.step({ key, type: "helper", ...step });
      pump();
    },
    tasks(list) {
      open();
      set("tasks", checkedTasks(list));
    },
    plan(markdown) {
      open();
      set("plan", append("", checkedText(markdown, "plan(text)"), PLAN_BYTES));
    },
    usage(usage) {
      open();
      set("usage", checkedUsage(usage));
    },
  };

  return {
    reports,
    /** Resolves (to undefined) when a write was refused twice. */
    broke,
    async settled() {
      while (flight) await flight;
    },
    /** Ends the writer: later reports throw. Returns why writing broke, if it did. */
    close() {
      closed = true;
      return broken;
    },
  };
}
