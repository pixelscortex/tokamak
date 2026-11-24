import { assertJson, type JsonValue } from "../src/values";
import { WORKER_DATA_BYTES } from "../src/worker-limits";

const MAX_DATA_DEPTH = 100;

export function wireData(value: unknown, label: string): JsonValue {
  assertJson(value, label, undefined, MAX_DATA_DEPTH);
  const text = JSON.stringify(value);
  if (text.length > WORKER_DATA_BYTES || new TextEncoder().encode(text).length > WORKER_DATA_BYTES)
    throw new Error(`${label} exceeds the plain-data size limit`);
  return JSON.parse(text) as JsonValue;
}
