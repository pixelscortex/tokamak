// The POC deliberately has one value language: lossless JSON. Keeping this rule
// shared by validators, the database and the client avoids engine-specific codecs.
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type Id<Table extends string = string> = string & {
  readonly __table: Table;
};

export function assertTable(table: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(table)) throw new Error(`Invalid table name: ${table}`);
}

export function assertId(value: unknown, table?: string): asserts value is Id {
  const logical = typeof value === "string" ? value.slice(value.indexOf("/") + 1) : "";
  if (
    typeof value !== "string" ||
    !/^(?:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\/)?[A-Za-z][A-Za-z0-9_]*:[A-Za-z0-9_-]+$/.test(value) ||
    (table !== undefined && !logical.startsWith(`${table}:`))
  ) {
    throw new Error(`Expected ${table ?? "table"}:key record id`);
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reject lossy JSON.stringify conversions rather than quietly changing data. */
export function assertJson(
  value: unknown,
  path = "value",
  ancestors = new Set<object>(),
  depthLeft = Infinity,
  omitUndefined = false,
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!isJsonContainer(value)) {
    throw new Error(`${path} must be a JSON value (numbers must be finite)`);
  }

  if (depthLeft <= 0) throw new Error(`${path} exceeds the JSON nesting limit`);
  if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol"))
      throw new Error(`${path} has a symbol key`);
    if (Array.isArray(value)) {
      assertJsonArray(value, path, ancestors, depthLeft - 1, omitUndefined);
    } else {
      for (const key of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!descriptor.enumerable || !("value" in descriptor))
          throw new Error(`${path}.${key} must be an enumerable data property`);
        if (omitUndefined && descriptor.value === undefined) continue;
        assertJson(descriptor.value, `${path}.${key}`, ancestors, depthLeft - 1, omitUndefined);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

/** Snapshot payloads so changing an input cannot mutate a pending query. */
export function jsonSnapshot(
  value: unknown,
  path = "value",
  maxDepth = Infinity,
  omitUndefined = false,
): JsonValue {
  assertJson(value, path, undefined, maxDepth, omitUndefined);
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function assertJsonArray(
  value: unknown[],
  path: string,
  ancestors: Set<object>,
  depthLeft: number,
  omitUndefined: boolean,
) {
  if (Object.getOwnPropertyNames(value).length !== value.length + 1)
    throw new Error(`${path} must be a dense JSON array without extra properties`);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !("value" in descriptor))
      throw new Error(`${path}[${i}] must be an enumerable data property`);
    assertJson(descriptor.value, `${path}[${i}]`, ancestors, depthLeft, omitUndefined);
  }
}

function isJsonContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null && (Array.isArray(value) || isPlainObject(value));
}
