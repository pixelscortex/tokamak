/** POC application limits keep every committed list deliverable in one native
 * event. This is application policy, not a larger/unbounded transport envelope. */
export const MAX_TITLE_UNITS = 200;
const MAX_LIST_BYTES = 48 * 1024;

export function assertReadable(todos: readonly object[]): void {
  // false is one byte longer than true. Budget every row in its larger state,
  // so a later toggle cannot turn a readable list into an oversized event.
  const json = JSON.stringify(todos.map((todo) => ({ ...todo, done: false })));
  let bytes = 0;
  for (const character of json) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  // JSON serialization above includes escapes, actual IDs, and creation times.
  // The remaining 16 KiB covers the protocol/result and host-topic envelopes.
  if (bytes > MAX_LIST_BYTES) {
    throw new Error("Task storage limit reached; remove a task before adding another");
  }
}
