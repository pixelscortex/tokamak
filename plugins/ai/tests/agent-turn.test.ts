import { expect, test, vi } from "vitest";
import type { AuthContext, JsonValue } from "@tokamak/sdk";
import type { AgentTurnStart } from "@tokamak/sdk/agent-turn";
import type { Agent } from "../src/contracts";
import { startAgent } from "../src/server/agent-turn";
import { turnControl } from "../src/server/controls";

const auth: AuthContext = {
  user: { id: "member", name: "Sam", role: "owner" },
  device: { id: "device", name: "This computer" },
};

function linkedTurn(turnId: string) {
  const input: AgentTurnStart = {
    threadId: "one-thread",
    turnId,
    folder: "/fixture",
    model: "replay",
    access: "ask",
    prompt: "Go",
    history: [],
  };
  const channel = Symbol.for("tokamak.contract.channel");
  let receive!: (method: string, args: JsonValue) => Promise<JsonValue>;
  let finish!: (result: JsonValue) => void;
  const result = new Promise<JsonValue>((resolve) => (finish = resolve));
  const send = vi.fn(async (_method: string, _input: JsonValue) => null);
  const close = vi.fn(async () => {});
  const stopPrograms = vi.fn(async () => {});
  const provider = {
    [channel](_method: string, _args: unknown, onMessage: typeof receive) {
      receive = onMessage;
      return { result, send, close, stopPrograms };
    },
  } as unknown as Agent;
  const text = vi.fn();
  const ask = vi.fn(async () => "approve" as const);
  const reports = {
    text,
    thinking: vi.fn(),
    plan: vi.fn(),
    tasks: vi.fn(),
    tool: vi.fn(),
    helper: vi.fn(),
    usage: vi.fn(),
    sessionChanged: vi.fn(),
  };
  const control = turnControl(turnId, auth);
  const running = startAgent(
    provider,
    input,
    reports,
    { ask, cancel: async () => {}, expire: () => {} },
    control,
  );
  return {
    send,
    close,
    stopPrograms,
    running,
    text,
    ask,
    control,
    message: (method: string, args: JsonValue & object) =>
      receive(method, { threadId: input.threadId, turnId, ...args }),
    async end() {
      finish({ sessionId: "replay" });
      await running;
      control.close();
    },
  };
}

test("an ended turn cannot report or ask in the next turn on its thread", async () => {
  const previous = linkedTurn("first");
  await previous.end();
  const current = linkedTurn("second");
  try {
    const late = { turnId: "first", events: [{ kind: "text", value: "old reply" }] };
    const question = { kind: "read", action: "read", subject: "file" };
    await previous.message("report", late);
    await current.message("report", late);
    expect(await previous.message("ask", { question })).toBe("cancel");
    expect(await current.message("ask", { turnId: "first", question })).toBe("cancel");
    expect(current.ask).not.toHaveBeenCalled();
    expect(previous.ask).not.toHaveBeenCalled();
    await current.message("report", { events: [{ kind: "text", value: "new reply" }] });
    expect(current.text.mock.calls).toEqual([["new reply"]]);
    expect(previous.text).not.toHaveBeenCalled();
  } finally {
    await current.end();
  }
});

test("an invalid report batch is rejected before writing any event", async () => {
  const turn = linkedTurn("unknown-report");
  try {
    await expect(
      turn.message("report", {
        events: [{ kind: "text", value: "must not be saved" }, { kind: "futureEvent" }],
      }),
    ).rejects.toThrow("Unknown agent turn report event: futureEvent");
    expect(turn.text).not.toHaveBeenCalled();
  } finally {
    await turn.end();
  }
});

test("an in-flight report is accepted until Force stop is acknowledged", async () => {
  const turn = linkedTurn("force-report");
  let release!: (value: null) => void;
  turn.send.mockReturnValueOnce(new Promise<null>((resolve) => (release = resolve)));
  const forcing = turn.control.forceStop();
  try {
    await Promise.resolve();
    await turn.message("report", { events: [{ kind: "text", value: "before the kill" }] });
    expect(turn.text.mock.calls).toEqual([["before the kill"]]);
  } finally {
    release(null);
    await forcing;
    await turn.end();
  }
});

test("a linked steer that crosses the turn end is not recorded", async () => {
  const turn = linkedTurn("late-steer");
  try {
    const record = vi.fn(async () => null);
    turn.send.mockRejectedValueOnce(new Error("This turn has ended"));
    await turn.message("report", { events: [{ kind: "steerReady" }] });
    await expect(turn.control.steer("too late", record)).resolves.toMatchObject({ kind: "NotRunning" });
    expect(record.mock.calls).toEqual([["pending"], ["failed"]]);
  } finally {
    await turn.end();
  }
});

test("early steers wait for provider readiness, then record and deliver in order", async () => {
  const turn = linkedTurn("early-steer");
  try {
    const order: string[] = [];
    const record = vi.fn(async (delivery?: string) => void order.push(delivery ?? ""));
    turn.send.mockImplementation(async () => {
      order.push("reaction");
      return null;
    });
    const first = turn.control.steer("one", record);
    const second = turn.control.steer("two", record);
    await Promise.resolve();
    expect(record).not.toHaveBeenCalled();
    expect(turn.send).not.toHaveBeenCalled();
    await turn.message("report", { events: [{ kind: "steerReady" }] });
    await expect(Promise.all([first, second])).resolves.toEqual([{ error: null }, { error: null }]);
    expect(turn.send.mock.calls).toEqual(
      ["one", "two"].map((text) => ["steer", { threadId: "one-thread", turnId: "early-steer", text }]),
    );
    expect(order).toEqual(["pending", "reaction", "delivered", "pending", "reaction", "delivered"]);
  } finally {
    await turn.end();
  }
});

test("a handler error withdraws the pending steer", async () => {
  const turn = linkedTurn("failed-steer");
  try {
    const record = vi.fn(async (_delivery?: string) => null);
    turn.send.mockRejectedValueOnce(new Error("The agent can no longer receive a steer"));
    await turn.message("report", { events: [{ kind: "steerReady" }] });
    await expect(turn.control.steer("follow-up", record)).resolves.toEqual({
      error: "The agent can no longer receive a steer",
    });
    expect(record.mock.calls).toEqual([["pending"], ["failed"]]);
  } finally {
    await turn.end();
  }
});

test("Force stop closes the link even while the agent's start never settles", async () => {
  const turn = linkedTurn("unsettled");
  try {
    await expect(turn.control.forceStop()).resolves.toBeNull();
    expect(turn.send.mock.calls).toEqual([["forceStop", { threadId: "one-thread", turnId: "unsettled" }]]);
    expect(turn.close).toHaveBeenCalledOnce();
    await expect(turn.running).resolves.toBeUndefined();
  } finally {
    await turn.end();
  }
});
