import { test, expect } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  copyFileSync,
  chmodSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Agents, type AgentEvent } from "../src/server/agents/client";
import { resolveCommand, checkFolder } from "../src/server/agents/discovery";

function fixture(transform: (source: string) => string = (source) => source) {
  const directory = mkdtempSync(join(tmpdir(), "tokamak-agent-"));
  const command = join(directory, "fake-agent");
  copyFileSync(new URL("./fake-agent.py", import.meta.url), command);
  writeFileSync(command, transform(readFileSync(command, "utf8")));
  chmodSync(command, 0o755);
  const agents = new Agents([{ id: "fake", title: "fake", command, args: [] }]);
  return {
    agents,
    command,
    close() {
      agents.close();
      rmSync(directory, { force: true, recursive: true });
    },
  };
}
async function turn(agents: Agents, text: string, optionId: string | null = "yes") {
  const events: AgentEvent[] = [];
  const opened = await agents.open({ agent: "fake", cwd: "/tmp" });
  for await (const event of agents.prompt({ agent: "fake", sessionId: opened.sessionId, text })) {
    events.push(event);
    if (event.type === "permission") await agents.respond({ requestId: event.requestId, optionId });
  }
  return events;
}
test("official SDK streams text, tools and plans and answers allow and deny", async () => {
  const f = fixture();
  try {
    const events = await turn(f.agents, "chat:normal");
    expect(
      events.filter((e) => e.type === "update").map((e) => e.type === "update" && e.update.sessionUpdate),
    ).toEqual([
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
      "plan",
      "plan",
      "agent_thought_chunk",
      "tool_call_update",
      "agent_message_chunk",
    ]);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    for (const option of ["yes", "no", null]) {
      const permission = await turn(f.agents, "chat:permission", option);
      expect(permission.some((e) => e.type === "permission")).toBe(true);
      const output = permission.findLast(
        (event) => event.type === "update" && event.update.sessionUpdate === "agent_message_chunk",
      );
      expect(
        JSON.parse(String(output?.type === "update" && (output.update.content as { text: string }).text)),
      ).toEqual(option === null ? { outcome: "cancelled" } : { outcome: "selected", optionId: option });
      expect(permission.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    }
  } finally {
    f.close();
  }
});
test("session resume across client restart and live adapter survives launcher removal", async () => {
  const f = fixture();
  try {
    const first = await f.agents.open({ agent: "fake", cwd: "/tmp" });
    expect(first.restored).toBe(false);
    expect(await f.agents.open({ agent: "fake", cwd: "/tmp", sessionId: first.sessionId })).toEqual({
      ...first,
      restored: true,
    });
    f.agents.close();
    expect(await f.agents.open({ agent: "fake", cwd: "/tmp", sessionId: first.sessionId })).toEqual({
      ...first,
      restored: true,
    });
    unlinkSync(f.command);
    expect(f.agents.agents()).toEqual([{ id: "fake", title: "fake" }]);
    expect((await turn(f.agents, "hello")).at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  } finally {
    f.close();
  }
});
test("cancellation settles pending permission and prompt", async () => {
  const f = fixture();
  try {
    const { sessionId } = await f.agents.open({ agent: "fake", cwd: "/tmp" });
    const iterator = f.agents.prompt({ agent: "fake", sessionId, text: "cancel" })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("permission");
    await f.agents.cancel({ agent: "fake", sessionId });
    expect((await iterator.next()).value).toEqual({ type: "done", stopReason: "cancelled" });
    await iterator.return?.();
    await expect(f.agents.respond({ requestId: "missing", optionId: "yes" })).rejects.toThrow(
      "Unknown ACP permission request",
    );
  } finally {
    f.close();
  }
});
test("folder expansion and unsafe executable discovery", () => {
  expect(checkFolder({ path: "" })).toBe(homedir());
  expect(checkFolder({ path: "~" })).toBe(homedir());
  expect(checkFolder({ path: "~/" })).toBe(homedir());
  expect(() => checkFolder({ path: "relative" })).toThrow("Agent folder must be an absolute path: relative");
  expect(() => checkFolder({ path: "/missing-tokamak-agent" })).toThrow(
    "Agent folder does not exist: /missing-tokamak-agent",
  );
  expect(() => checkFolder({ path: "/dev/null" })).toThrow("Agent folder does not exist: /dev/null");
  const f = fixture();
  try {
    expect(resolveCommand("fake-agent", ["", ".", f.command.slice(0, f.command.lastIndexOf("/"))])).toBe(
      f.command,
    );
    const unsafe = f.command + ".unsafe";
    mkdirSync(unsafe);
    chmodSync(unsafe, 0o777);
    symlinkSync(f.command, join(unsafe, "agent"));
    expect(resolveCommand("agent", [unsafe])).toBeUndefined();
    chmodSync(f.command, 0o775);
    expect(resolveCommand(f.command)).toBeUndefined();
  } finally {
    f.close();
  }
});

test("crash, oversized messages, and a flooded event queue fail without poisoning the next process", async () => {
  const f = fixture();
  try {
    await expect(turn(f.agents, "crash")).rejects.toThrow(/ACP/);
    expect((await turn(f.agents, "hello")).at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    await expect(turn(f.agents, "huge-line")).rejects.toThrow();
    expect((await turn(f.agents, "hello")).at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    const opened = await f.agents.open({ agent: "fake", cwd: "/tmp" });
    const stream = f.agents
      .prompt({ agent: "fake", sessionId: opened.sessionId, text: "flood" })
      [Symbol.asyncIterator]();
    await stream.next();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(
      (async () => {
        while (!(await stream.next()).done) {
          /* let the bounded queue drain to its error */
        }
      })(),
    ).rejects.toThrow();
    expect((await turn(f.agents, "hello")).at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  } finally {
    f.close();
  }
});
test("an ignored cancel kills the adapter and allows the next turn", async () => {
  const f = fixture();
  try {
    const opened = await f.agents.open({ agent: "fake", cwd: "/tmp" });
    const stream = f.agents
      .prompt({ agent: "fake", sessionId: opened.sessionId, text: "ignore-cancel" })
      [Symbol.asyncIterator]();
    expect((await stream.next()).value?.type).toBe("permission");
    await f.agents.cancel({ agent: "fake", sessionId: opened.sessionId });
    await expect(stream.next()).rejects.toThrow(/cancel|closed/i);
    expect((await turn(f.agents, "hello")).at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  } finally {
    f.close();
  }
}, 10_000);

test("a blocked adapter stdin has a write deadline", async () => {
  const f = fixture((source) =>
    source.replace(
      "response(request, dict(sessionId=params.get('sessionId', 'session')))",
      "response(request, dict(sessionId=params.get('sessionId', 'session')))\n        import time; time.sleep(60)",
    ),
  );
  try {
    await expect(turn(f.agents, "x".repeat(900_000))).rejects.toThrow("stdin write timed out");
  } finally {
    f.close();
  }
}, 20_000);

test("an initializing adapter has a deadline while another agent remains usable", async () => {
  const f = fixture((source) =>
    source.replace(
      "if os.environ.get('ACP_TEST_HANG_INITIALIZE'):",
      "if len(sys.argv) > 1 and sys.argv[1] == 'slow':",
    ),
  );
  const agents = new Agents([
    { id: "slow", title: "slow", command: f.command, args: ["slow"] },
    { id: "fake", title: "fake", command: f.command, args: [] },
  ]);
  try {
    const slow = agents.open({ agent: "slow", cwd: "/tmp" });
    const failure = expect(slow).rejects.toThrow("initialize timed out");
    const fast = await turn(agents, "hello");
    expect(fast.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    await failure;
  } finally {
    agents.close();
    f.close();
  }
}, 35_000);

test("crash reports the stderr tail even if a detached descendant holds stderr", async () => {
  const f = fixture();
  let descendant: number | undefined;
  try {
    await f.agents.open({ agent: "fake", cwd: "/tmp" });
    const start = Date.now();
    try {
      await turn(f.agents, "stderr-held");
      throw new Error("expected agent crash");
    } catch (error) {
      expect(String(error)).toContain("ACP_HELD_TAIL");
      descendant = Number(/ACP_STDERR_CHILD:(\d+):/.exec(String(error))?.[1]);
      expect(descendant).toBeGreaterThan(0);
      expect(Date.now() - start).toBeLessThan(3000);
    }
  } finally {
    if (descendant) process.kill(descendant, "SIGKILL");
    f.close();
  }
});
