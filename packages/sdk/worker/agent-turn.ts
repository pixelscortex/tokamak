import {
  type AgentTurnAsk,
  type AgentTurnEvent,
  type AgentTurnReport,
  AGENT_TURN_PROTOCOL,
  ASK_FOR_TURN,
  permissionAnswer,
  TURN_ENDED,
  type AgentTurnOpen,
  type AgentTurnSteer,
  type Question,
  type Run,
  type TurnAddress,
  type TurnAnswer,
  type TurnRun,
} from "../src/agent-turn";
import {
  append,
  checkedHelper,
  checkedTasks,
  checkedText,
  checkedTool,
  checkedUsage,
  jsonBytes,
  PLAN_BYTES,
  TEXT_BYTES,
  WRITE_BYTES,
} from "../src/agent-reports";
import type { HostBridge } from "../src/host";
import type { JsonValue } from "../src/values";

// Bound unsent reports plus the batch awaiting acknowledgement. Charge for
// each JS entry as well as its wire bytes, so tiny events cannot fill the heap.
const BUFFER_BYTES = 768 * 1024;
const ENTRY_BYTES = 64;

function batches(address: TurnAddress, send: NonNullable<HostBridge["channel"]>["send"]) {
  type Entry = { event: AgentTurnEvent; bytes: number };
  const pending = new Map<number | "tasks" | "plan" | "usage", Entry>();
  const overhead = jsonBytes({ ...address, events: [] });
  let next = 0;
  let last: Entry | undefined;
  let buffered = 0;
  let flight: Promise<void> | undefined;
  let failed: unknown;
  let closed = false;
  let sealed = false;
  let reject!: (cause: unknown) => void;
  const failure = new Promise<never>((_, fail) => (reject = fail));
  void failure.catch(() => {});
  function fail(error: unknown) {
    failed = error;
    reject(error);
  }

  function drain() {
    if (flight || !pending.size || failed !== undefined) return;
    flight = (async () => {
      while (pending.size && failed === undefined) {
        const events: AgentTurnEvent[] = [];
        let size = overhead;
        let charge = 0;
        for (const [key, entry] of pending) {
          if (size + entry.bytes >= WRITE_BYTES) break;
          events.push(entry.event);
          size += entry.bytes;
          charge += entry.bytes + ENTRY_BYTES;
          pending.delete(key);
          if (last === entry) last = undefined;
        }
        const report: AgentTurnReport = { ...address, events };
        await send("report", report as unknown as JsonValue);
        buffered -= charge;
      }
    })()
      .catch(fail)
      .finally(() => {
        flight = undefined;
      });
  }

  let idle: ReturnType<typeof setTimeout> | undefined;
  return {
    failure,
    push(event: AgentTurnEvent) {
      if (sealed) return;
      if (closed) throw new Error(TURN_ENDED);
      if (failed !== undefined) throw failed;
      const kind = event.kind;
      if (last && (kind === "text" || kind === "thinking") && last.event.kind === kind) {
        // JSON strings concatenate without an extra event envelope. A split
        // surrogate pair only gets smaller when joined, so this is an upper bound.
        const added = jsonBytes(event.value) - 2;
        if (last.bytes + added + overhead < WRITE_BYTES && buffered + added <= BUFFER_BYTES) {
          last.event = { kind, value: last.event.value + event.value };
          last.bytes += added;
          buffered += added;
          return;
        }
      }
      const key = kind === "tasks" || kind === "plan" || kind === "usage" ? kind : next++;
      const previous = pending.get(key);
      if (previous) {
        pending.delete(key);
        buffered -= previous.bytes + ENTRY_BYTES;
      }
      const bytes = jsonBytes(event) + 1;
      if (bytes + overhead >= WRITE_BYTES || buffered + bytes + ENTRY_BYTES > BUFFER_BYTES) {
        const error = new Error("The agent produced output faster than it could be saved.");
        fail(error);
        throw error;
      }
      last = { event, bytes };
      pending.set(key, last);
      buffered += bytes + ENTRY_BYTES;
      idle ??= setTimeout(() => {
        idle = undefined;
        drain();
      }, 0);
    },
    async flush() {
      while (pending.size || flight) {
        if (failed !== undefined) throw failed;
        drain();
        await flight;
      }
      if (failed !== undefined) throw failed;
    },
    seal() {
      sealed = true;
    },
    close() {
      closed = true;
      clearTimeout(idle);
      pending.clear();
      last = undefined;
    },
  };
}

function reportMethods(
  reports: ReturnType<typeof batches>,
): Pick<Run, "text" | "thinking" | "plan" | "tasks" | "tool" | "helper" | "usage" | "sessionChanged"> {
  const whole = { text: "", thinking: "" };
  function text(kind: "text" | "thinking", delta: string) {
    const previous = whole[kind];
    const value = append(previous, checkedText(delta, `${kind}(delta)`), TEXT_BYTES);
    whole[kind] = value;
    if (value.length > previous.length) reports.push({ kind, value: value.slice(previous.length) });
  }
  return {
    text: (value) => text("text", value),
    thinking: (value) => text("thinking", value),
    plan: (value) =>
      reports.push({ kind: "plan", value: append("", checkedText(value, "plan(text)"), PLAN_BYTES) }),
    tasks: (value) => reports.push({ kind: "tasks", value: checkedTasks(value) }),
    tool: (value) => reports.push({ kind: "tool", value: checkedTool(value) }),
    helper: (value) => reports.push({ kind: "helper", value: checkedHelper(value) }),
    usage: (value) => reports.push({ kind: "usage", value: checkedUsage(value) }),
    sessionChanged: (value) => reports.push({ kind: "session", value: value ?? null }),
  };
}

/** Adapt the agent's ordinary Run to a channel tied to this invocation and its program scope. */
export function agentTurn<T>(
  request: AgentTurnOpen,
  bridge: HostBridge,
  start: (run: Run, scoped: HostBridge) => T | Promise<T>,
) {
  const { version, threadId, turnId, ...input } = request;
  if (version !== AGENT_TURN_PROTOCOL)
    throw new Error(
      `Agent turn protocol mismatch: ai uses version ${typeof version === "number" ? version : "unversioned"}; the plugin host uses version ${AGENT_TURN_PROTOCOL}. Update Tokamak and the ai plugin together.`,
    );
  if (typeof threadId !== "string" || typeof turnId !== "string")
    throw new TypeError("An agent turn requires a thread and turn id");
  if (!bridge.channel || !bridge.withPrograms)
    throw new Error("Agent turns require a local contract channel");
  const channel = bridge.channel;
  const address = { threadId, turnId };
  return bridge.withPrograms(async (_kill, scoped) => {
    const reports = batches(address, channel.send);

    let questionLine: Promise<unknown> = Promise.resolve();
    let steer: Parameters<Run["onSteer"]>[0] | undefined;
    let stop: Parameters<Run["onStop"]>[0] | undefined;
    let stopRequested = false;
    let stopSent = false;
    let forceRequested = false;
    let closed = false;
    const close = () => {
      closed = true;
      reports.close();
    };
    let release!: () => void;
    const cancelled = new Promise<void>((resolve) => (release = resolve));
    const abort = () => {
      close();
      release();
    };
    scoped.signal?.addEventListener("abort", abort, { once: true });

    function stopWhenReady() {
      if (!stopRequested || !stop || stopSent || closed || forceRequested) return;
      stopSent = true;
      const handler = stop;
      void (async () => {
        // The manager cancels the question first. Let the agent deliver its
        // answer to the CLI before running its interrupt handler.
        await questionLine;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!closed && !forceRequested) await handler();
      })().catch(() => {});
    }
    channel.receive(async (method, args) => {
      const target = args as unknown as TurnAddress;
      if (closed || target?.threadId !== threadId || target.turnId !== turnId) throw new Error(TURN_ENDED);
      switch (method) {
        case "steer": {
          if (forceRequested) throw new Error(TURN_ENDED);
          if (stopRequested || !steer) throw new Error("The agent can no longer receive a steer");
          await steer((args as unknown as AgentTurnSteer).text);
          return null;
        }
        case "stop":
          stopRequested = true;
          stopWhenReady();
          return null;
        case "forceStop":
          forceRequested = true;
          reports.seal();
          await reports.flush();
          return null;
        default:
          throw new Error(`Unknown agent turn control: ${method}`);
      }
    });
    function ask(question: Question) {
      const request: AgentTurnAsk = { ...address, question };
      const answer = questionLine.then(async (): Promise<TurnAnswer> => {
        try {
          await reports.flush();
          if (closed) return "cancel";
          if (stopRequested || forceRequested) return "stopping";
          const reply = await channel.send("ask", request as unknown as JsonValue);
          if (
            reply === "approve" ||
            reply === "approveSession" ||
            reply === "decline" ||
            reply === "cancel" ||
            reply === "stopping"
          )
            return reply;
          throw new Error("Invalid agent question answer");
        } catch (error) {
          if (closed || scoped.signal?.aborted) return "cancel";
          throw error;
        }
      });
      questionLine = answer.catch(() => {});
      return answer;
    }
    const run: TurnRun = {
      ...input,
      ...reportMethods(reports),
      [ASK_FOR_TURN]: ask,
      ask: async (question) => permissionAnswer(await ask(question)),
      onSteer(handler) {
        if (!steer) reports.push({ kind: "steerReady" });
        steer = handler;
      },
      onStop(handler) {
        stop = handler;
        stopWhenReady();
      },
    };
    try {
      return await Promise.race([start(run, scoped), reports.failure]);
    } finally {
      try {
        // The manager must receive every accepted batch before start settles.
        if (!closed) await reports.flush();
        // A killed program can make start settle before the kill reply is
        // sent. Keep the link until the manager acknowledges it by closing.
        if (forceRequested) await cancelled;
      } finally {
        scoped.signal?.removeEventListener("abort", abort);
        close();
      }
    }
  });
}
