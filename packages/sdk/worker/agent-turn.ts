import {
  type AgentTurnAsk,
  type AgentTurnEvent,
  type AgentTurnReport,
  type AgentTurnStart,
  type AgentTurnSteer,
  type Answer,
  type Run,
  type TurnAddress,
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

function batches(address: TurnAddress, send: NonNullable<HostBridge["channel"]>["send"]) {
  let next: AgentTurnEvent[] = [];
  let queue: AgentTurnEvent[][] = [];
  const overhead = jsonBytes({ ...address, events: [] });
  let size = overhead;
  let buffered = 0;
  let flight: Promise<void> | undefined;
  let failed: unknown;
  let closed = false;
  let reject!: (cause: unknown) => void;
  const failure = new Promise<never>((_, fail) => (reject = fail));
  void failure.catch(() => {});
  function drain() {
    if (next.length) {
      queue.push(next);
      next = [];
      size = overhead;
    }
    if (flight || !queue.length || failed !== undefined) return;
    flight = (async () => {
      while (queue.length) {
        const events = queue.shift()!;
        const report: AgentTurnReport = { ...address, events };
        await send("report", report as unknown as JsonValue);
        buffered -= jsonBytes(events) - 1;
      }
    })()
      .catch((error) => {
        failed = error;
        reject(error);
      })
      .finally(() => {
        flight = undefined;
      });
  }

  let idle: ReturnType<typeof setTimeout> | undefined;
  return {
    failure,
    push(event: AgentTurnEvent) {
      if (closed) throw new Error("This turn has ended");
      if (failed !== undefined) throw failed;
      const bytes = jsonBytes(event) + 1;
      if (bytes + overhead >= WRITE_BYTES || buffered + bytes >= 8 * WRITE_BYTES)
        throw new Error("Agent report buffer exceeds its size limit");
      if (size + bytes >= WRITE_BYTES) drain();
      next.push(event);
      size += bytes;
      buffered += bytes;
      idle ??= setTimeout(() => {
        idle = undefined;
        drain();
      }, 0);
    },
    async flush() {
      while (next.length || flight || queue.length) {
        if (failed !== undefined) throw failed;
        drain();
        await flight;
      }
      if (failed !== undefined) throw failed;
    },
    close() {
      closed = true;
      clearTimeout(idle);
      next = [];
      queue = [];
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
  request: AgentTurnStart,
  bridge: HostBridge,
  start: (run: Run, scoped: HostBridge) => T | Promise<T>,
) {
  const { threadId, turnId, ...input } = request;
  if (typeof threadId !== "string" || typeof turnId !== "string")
    throw new TypeError("An agent turn requires a thread and turn id");
  if (!bridge.channel || !bridge.withPrograms)
    throw new Error("Agent turns require a local contract channel");
  const channel = bridge.channel;
  const address = { threadId, turnId };
  return bridge.withPrograms(async (kill, scoped) => {
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
      if (!stopRequested || !stop || stopSent || closed) return;
      stopSent = true;
      const handler = stop;
      void (async () => {
        // The manager cancels the question first. Let the agent deliver its
        // answer to the CLI before running its interrupt handler.
        await questionLine;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!closed) await handler();
      })().catch(() => {});
    }
    channel.receive(async (method, args) => {
      const target = args as unknown as TurnAddress;
      if (closed || target?.threadId !== threadId || target.turnId !== turnId) return null;
      switch (method) {
        case "steer": {
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
          close();
          await kill();
          return null;
        default:
          throw new Error(`Unknown agent turn control: ${method}`);
      }
    });
    const run: Run = {
      ...input,
      ...reportMethods(reports),
      ask(question) {
        const request: AgentTurnAsk = { ...address, question };
        const answer = questionLine.then(async (): Promise<Answer> => {
          try {
            await reports.flush();
            if (closed || stopRequested) return "cancel";
            const reply = await channel.send("ask", request as unknown as JsonValue);
            if (
              reply === "approve" ||
              reply === "approveSession" ||
              reply === "decline" ||
              reply === "cancel"
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
      },
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
