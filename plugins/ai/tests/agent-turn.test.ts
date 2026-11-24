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
  const provider = {
    [channel](_method: string, _args: unknown, onMessage: typeof receive) {
      receive = onMessage;
      return { result, send, close };
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

test("early steers wait for provider readiness, then record and deliver in order", async () => {
  const turn = linkedTurn("early-steer");
  try {
    const record = vi.fn(async () => null);
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
