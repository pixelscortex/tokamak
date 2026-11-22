/**
 * How much of an agent's reports `ai` keeps, so no row, no write and no query
 * answer comes near the 1 MiB frame the server and the local worker accept.
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
