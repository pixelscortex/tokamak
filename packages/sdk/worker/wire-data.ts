import { assertJson, type JsonValue } from "../src/values";
import { WORKER_FRAME_BYTES } from "../src/worker-limits";

// Leave room for operation, invocation and channel envelopes.
const MAX_DATA_BYTES = WORKER_FRAME_BYTES - 16 * 1024;
const MAX_DATA_DEPTH = 100;

export function wireData(value: unknown, label: string): JsonValue {
  assertJson(value, label, undefined, MAX_DATA_DEPTH);
  const text = JSON.stringify(value);
  if (text.length > MAX_DATA_BYTES || new TextEncoder().encode(text).length > MAX_DATA_BYTES)
    throw new Error(`${label} exceeds the plain-data size limit`);
  return JSON.parse(text) as JsonValue;
}
