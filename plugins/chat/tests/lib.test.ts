import { expect, test } from "vitest";
import { agentOf, folderName } from "../src/client/lib/agents";
import { nearEnd } from "../src/client/lib/follow";
import { chatKeys } from "../src/client/lib/state/chat-keys";
import {
  age,
  clock,
  foldTurn,
  pendingPermission,
  permissionOptions,
  promptBefore,
  type Message,
  type Part,
} from "../src/client/lib/turns";
import { decode, lex } from "../src/client/ui/thread/markdown";

let id = 0;
function message(role: "user" | "assistant", parts: Part[], status: Message["status"] = "complete") {
  return { _id: `m${++id}`, threadId: "t1", role, parts, status, createdAt: id } as unknown as Message;
}
const tool = (callId: string, status: "running" | "done" | "error", summary?: string): Part => ({
  type: "tool",
  callId,
  plugin: "acp:claude",
  toolName: "read",
  args: {},
  status,
  ...(summary ? { summary } : {}),
});
const permission = (requestId: string, status: "pending" | "answered", optionId?: string): Part => ({
  type: "permission",
  requestId,
  callId: "c",
  title: "git push",
  status,
  ...(optionId ? { optionId } : {}),
  options: [
    { optionId: "deny", name: "Deny", kind: "reject_once" },
    { optionId: "allow", name: "Allow", kind: "allow_once" },
  ],
});

test("a turn folds its tools into one work summary and keeps its text in order", () => {
  const done = foldTurn(
    message("assistant", [
      { type: "text", text: "Before." },
      tool("a", "done", "Read file"),
      tool("b", "done"),
      { type: "text", text: "After." },
    ]),
  );
  expect(done.texts).toEqual(["Before.", "After."]);
  expect(done.work).toMatchObject({ actions: 2, running: false, failed: false });
  expect(done.work!.steps.map((step) => step.label)).toEqual(["Read file", "Read"]);

  const running = foldTurn(
    message("assistant", [tool("a", "done", "Read"), tool("b", "running", "Running tests")], "streaming"),
  );
  expect(running.work).toMatchObject({ running: true, latest: "Running tests" });

  const waiting = foldTurn(
    message("assistant", [tool("a", "running"), permission("p", "pending")], "streaming"),
  );
  expect(waiting.work).toMatchObject({ waiting: true, latest: "Waiting for you", actions: 1 });

  expect(foldTurn(message("assistant", [tool("a", "error")], "cancelled")).work?.failed).toBe(false);
  expect(foldTurn(message("assistant", [tool("a", "error")], "error")).work?.failed).toBe(true);
  expect(foldTurn(message("assistant", [], "streaming")).work).toMatchObject({
    latest: "Working",
    actions: 0,
  });
  expect(foldTurn(message("assistant", [{ type: "text", text: "Hi" }])).work).toBeUndefined();
});

test("permission answers put allow first and only unanswered requests are pending", () => {
  const part = permission("p", "pending") as Extract<Part, { type: "permission" }>;
  expect(permissionOptions(part).map((option) => option.optionId)).toEqual(["allow", "deny"]);
  const messages = [
    message("user", [{ type: "text", text: "go" }]),
    message("assistant", [permission("old", "answered", "allow"), permission("new", "pending")], "streaming"),
  ];
  expect(pendingPermission(messages)?.part.requestId).toBe("new");
  const reserved = [message("assistant", [permission("p", "pending", "allow")], "streaming")];
  expect(pendingPermission(reserved)).toBeUndefined();
});

test("retry finds the prompt that a failed reply answered", () => {
  const ask = message("user", [{ type: "text", text: "Fix the test" }]);
  const failed = message("assistant", [], "error");
  expect(promptBefore([ask, failed], failed._id)).toBe("Fix the test");
});

test("timers, ages and folder names read the way the rows show them", () => {
  expect(clock(4_200)).toBe("0:04");
  expect(clock(72_000)).toBe("1:12");
  expect(clock(3_723_000)).toBe("1:02:03");
  const now = 10_000_000_000;
  expect(age(now - 20_000, now)).toBe("now");
  expect(age(now - 4 * 60_000, now)).toBe("4m");
  expect(age(now - 3 * 3_600_000, now)).toBe("3h");
  expect(age(now - 2 * 86_400_000, now)).toBe("2d");
  expect(folderName("/Users/kira/code/tokamak/")).toBe("tokamak");
  expect(folderName("")).toBe("");
});

test("agents are named by their maker, never by the CLI", () => {
  const claude = agentOf({ kind: "plugin", plugin: "acp", backendId: "claude", settings: { cwd: "/w" } });
  expect(claude).toMatchObject({ name: "Claude", folder: "/w" });
  expect(agentOf({ kind: "plugin", plugin: "acp", backendId: "codex" })?.name).toBe("Codex");
  expect(
    agentOf({ kind: "plugin", plugin: "x", backendId: "mystery" }, [
      { id: "mystery", plugin: "x", title: "helper" },
    ])?.name,
  ).toBe("Helper");
  expect(agentOf(undefined)).toBeUndefined();
});

test("streaming markdown keeps the identity of blocks that did not change", () => {
  const first = lex("# Title\n\nOne paragraph.\n\nTwo")!;
  const second = lex("# Title\n\nOne paragraph.\n\nTwo more words", first)!;
  expect(second[0]).toBe(first[0]);
  expect(second.at(-1)).not.toBe(first.at(-1));
  expect(decode("a &amp; b &lt;c&gt; &#x1F600;")).toBe("a & b <c> 😀");
});

test("following stops once the reader scrolls more than a line from the end", () => {
  expect(nearEnd({ scrollTop: 968, scrollHeight: 1000, clientHeight: 0 })).toBe(true);
  expect(nearEnd({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
});

test("Esc stops a running reply and digits answer a permission only with an empty draft", () => {
  const calls: string[] = [];
  let draft = "";
  const keys = chatKeys({
    draft: () => draft,
    canStop: () => true,
    stop: () => calls.push("stop"),
    answer: (index) => (calls.push(`answer ${index}`), true),
  });
  const press = (key: string) => {
    const event = new KeyboardEvent("keydown", { key, cancelable: true });
    keys(event);
    return event.defaultPrevented;
  };
  expect(press("Escape")).toBe(true);
  expect(press("1")).toBe(true);
  draft = "typing 1";
  expect(press("2")).toBe(false);
  expect(calls).toEqual(["stop", "answer 0"]);
});

test("keys pressed inside a menu or dialog in the thread are left to it", () => {
  const calls: string[] = [];
  const keys = chatKeys({
    draft: () => "",
    canStop: () => true,
    stop: () => calls.push("stop"),
    answer: () => true,
  });
  const menu = document.body.appendChild(document.createElement("div"));
  menu.setAttribute("role", "menu");
  const item = menu.appendChild(document.createElement("button"));
  const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
  item.addEventListener("keydown", (inner) => keys(inner));
  item.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(calls).toEqual([]);
});
