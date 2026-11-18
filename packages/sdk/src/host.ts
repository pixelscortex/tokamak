// This is the host operation contract, not a transport protocol. The runtime
// converts serde_json at the boundary and injects a bridge bound to ONE call.
// The host must reject expired calls and query writes, and own transactions;
// a feature must never obtain a process-global database capability.
import type { Id, JsonObject, JsonValue } from "./values";
import { assertJson } from "./values";

export type StoredDocument = JsonObject & { _id: Id; _creationTime: number };

export interface EqualityClause {
  field: string;
  value: JsonValue;
}

export interface RangeClause extends EqualityClause {
  operator: "gt" | "gte" | "lt" | "lte";
}

export interface IndexQuery {
  name: string;
  eq: EqualityClause[];
  range: RangeClause[];
}

export interface QueryRequest {
  table: string;
  where: EqualityClause[];
  index?: IndexQuery;
  order: "asc" | "desc";
  limit: number | null;
}

/**
 * Sole source for names and payload/result shapes used by the SDK and host.
 * where clauses are ANDed, with JSON structural equality (object key order is
 * irrelevant). Fields are top-level names, not SurrealQL or dotted paths.
 * Unindexed queries sort by (_creationTime, _id). Indexed queries sort by index
 * fields and ID; eq follows the leading fields, range bounds the next field.
 * Indexed requests require an empty where array.
 * Missing get -> null; missing patch/replace -> error; missing delete -> null.
 * Patch merges top-level keys; replace preserves _id and _creationTime.
 * Writes cannot supply system fields. No undefined/delete-field sentinel.
 */
export interface HostOperations {
  "user.current": { args: {}; result: import("./functions").User };
  "db.get": { args: { id: string }; result: StoredDocument | null };
  "db.insert": { args: { table: string; value: JsonObject }; result: Id };
  "db.patch": { args: { id: string; value: JsonObject }; result: null };
  "db.replace": { args: { id: string; value: JsonObject }; result: null };
  "db.delete": { args: { id: string }; result: null };
  "db.query": { args: QueryRequest; result: StoredDocument[] };
  "action.env": { args: { name: string }; result: string | null };
  "action.runQuery": { args: { name: string; args: JsonValue }; result: JsonValue };
  "action.runMutation": { args: { name: string; args: JsonValue }; result: JsonValue };
  "plugin.call": { args: { name: string; args: JsonValue }; result: JsonValue };
  "plugin.providers": { args: { interface: string }; result: string[] };
}

export type HostOperation = keyof HostOperations;

/** Structural AbortSignal subset keeps the portable SDK free of DOM globals. */
export interface ActionSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface HostBridge {
  readonly user?: import("./functions").User;
  readonly signal?: ActionSignal;
  /** Reject on errors. Values cross once, without an extra JSON string envelope. */
  op(name: HostOperation, payload: JsonValue): JsonValue | Promise<JsonValue>;
}

/** Keep operation call sites tied to the contract even though the bridge is erased. */
export async function callHost<K extends HostOperation>(
  host: HostBridge,
  name: K,
  payload: HostOperations[K]["args"],
): Promise<HostOperations[K]["result"]> {
  assertJson(payload, `${name} payload`);
  const result = await host.op(name, payload);
  assertJson(result, `${name} result`);
  return result as HostOperations[K]["result"];
}
