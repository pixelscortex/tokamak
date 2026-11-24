import type { Helper, Task, Tool, Usage } from "./agent-turn";

/**
 * Bounds for agent reports shared by the writer and the plugin process adapter.
 * These keep reports, writes and query answers inside the 1 MiB frame limit.
 * Sizes are JSON bytes (UTF-8 after escaping), as they travel.
 */

/** The reply's text, the thinking and one helper's answer: 256 KB each. */
export const TEXT_BYTES = 256 * 1024;
/** A plan is drawn in every reply of the thread's live query, so it is kept smaller. */
export const PLAN_BYTES = 64 * 1024;
/** A step's title or detail, a task, an error: one line of a row. */
export const LINE_CHARS = 300;
/** At most this many tasks are kept from a to-do list. */
export const TASKS_MAX = 100;
/** One `turns:write` stays under this; what does not fit goes in the next one. */
export const WRITE_BYTES = 640 * 1024;
/** Ends a text that reached its limit; nothing is added after it. */
const CUT = "\n…cut";

/** What one character costs inside a JSON string. */
function cost(point: number): number {
  if (point === 0x22 || point === 0x5c) return 2;
  if (point < 0x20) return [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(point) ? 2 : 6;
  return point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
}

/** The size of `value` as JSON, in UTF-8 bytes. */
export function jsonBytes(value: unknown): number {
  let bytes = 0;
  for (const character of JSON.stringify(value) ?? "null") {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** The longest start of `text` that costs at most `bytes` inside a JSON string (whole characters only). */
export function fit(text: string, bytes: number): string {
  let used = 0;
  let end = 0;
  for (const character of text) {
    used += cost(character.codePointAt(0)!);
    if (used > bytes) break;
    end += character.length;
  }
  return text.slice(0, end);
}

/**
 * `stored` with `delta` appended, kept under `limit`: a text that would grow
 * past it is cut and ends with `CUT`, and a cut text takes nothing more.
 */
export function append(stored: string, delta: string, limit: number): string {
  if (stored.endsWith(CUT)) return stored;
  const room = limit - jsonBytes(stored);
  if (jsonBytes(delta) <= room) return stored + delta;
  return stored + fit(delta, room - jsonBytes(CUT)) + CUT;
}

/** One row line: the first line of `text`, at most `LINE_CHARS` characters, "…" when cut. */
export function line(text: string, chars = LINE_CHARS): string {
  const first = text.split("\n", 1)[0]!;
  return first.length > chars || first !== text ? `${first.slice(0, chars)}…` : first;
}

const KINDS: readonly string[] = [
  "command",
  "read",
  "edit",
  "search",
  "web",
  "other",
] satisfies Tool["kind"][];
const STATES: readonly string[] = ["running", "done", "failed"] satisfies Tool["state"][];
const TASK_STATES: readonly string[] = ["pending", "running", "done"];

/** Refuses a malformed report back to the agent that made it, before anything is stored. */
export function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new TypeError(`ai: ${what}`);
}
const isText = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function checkedText(value: unknown, what: string): string {
  check(isText(value), `${what} takes a string`);
  return value;
}

export function checkedTool(tool: Tool): Tool {
  check(isText(tool?.id) && tool.id !== "", "a tool needs an id");
  check(KINDS.includes(tool.kind), `a tool's kind is one of ${KINDS.join(", ")}`);
  check(isText(tool.title), "a tool needs a title");
  check(tool.detail === undefined || isText(tool.detail), "a tool's detail is a string");
  check(STATES.includes(tool.state), `a tool's state is one of ${STATES.join(", ")}`);
  const { id, kind, title, detail, state } = tool;
  return {
    id,
    kind,
    title: line(title),
    ...(detail !== undefined && { detail: line(detail) }),
    state,
  };
}

export function checkedHelper(helper: Helper): Helper {
  check(isText(helper?.id) && helper.id !== "", "a helper needs an id");
  check(isText(helper.name) && isText(helper.title), "a helper needs a name and a title");
  check(helper.text === undefined || isText(helper.text), "a helper's text is a string");
  check(STATES.includes(helper.state), `a helper's state is one of ${STATES.join(", ")}`);
  const { id, name, title, state, text } = helper;
  return {
    id,
    name: line(name),
    title: line(title),
    ...(text !== undefined && { text: append("", text, TEXT_BYTES) }),
    state,
  };
}

export function checkedTasks(list: readonly Task[]): Task[] {
  check(Array.isArray(list), "tasks(list) takes an array");
  for (const item of list)
    check(isText(item?.text) && TASK_STATES.includes(item.state), "a task is { text, state }");
  return list.slice(0, TASKS_MAX).map(({ text, state }) => ({ text: line(text), state }));
}

export function checkedUsage(usage: Usage): Usage {
  const { inputTokens, outputTokens, cachedInputTokens, costUsd } = usage ?? ({} as Usage);
  check(isCount(inputTokens) && isCount(outputTokens), "usage needs inputTokens and outputTokens (counts)");
  check(cachedInputTokens === undefined || isCount(cachedInputTokens), "cachedInputTokens is a count");
  check(costUsd === undefined || isCount(costUsd), "costUsd is a non-negative number");
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens !== undefined && { cachedInputTokens }),
    ...(costUsd !== undefined && { costUsd }),
  };
}
