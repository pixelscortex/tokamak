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
  "auth.current": {
    args: { call?: true };
    result: (import("./functions").CallContext & { hookPoints?: readonly string[] }) | null;
  };
  "point.stage": {
    args: { name: string; stage: "before" | "after" | "collect"; args: JsonValue; result?: JsonValue };
    result: JsonValue;
  };
  "crypto.hashPassword": { args: { password: string }; result: string };
  "crypto.verifyPassword": { args: { password: string; hash: string }; result: boolean };
  "crypto.verifyAndRehashPassword": {
    args: { password: string; hash: string };
    result: { valid: boolean; replacementHash?: string };
  };
  "db.get": { args: { id: string }; result: StoredDocument | null };
  "db.insert": { args: { table: string; value: JsonObject }; result: Id };
  "db.patch": { args: { id: string; value: JsonObject }; result: null };
  "db.replace": { args: { id: string; value: JsonObject }; result: null };
  "db.delete": { args: { id: string }; result: null };
  "db.query": { args: QueryRequest; result: StoredDocument[] };
  "machines.list": { args: {}; result: import("./functions").MachineEntry[] };
  "machines.listAll": { args: {}; result: import("./functions").MachineEntry[] };
  "machines.create": {
    args: { name: string; member?: string };
    result: import("./functions").MachineCreation;
  };
  "machines.remove": {
    args: { id: import("./functions").MachineId };
    result: null | import("./functions").Failure<"machineForbidden", null>;
  };
  "machines.waitOnline": {
    args: { id: import("./functions").MachineId; timeoutMs?: number };
    result: null | import("./functions").Failure<"machineForbidden" | "machineOffline", null>;
  };
  "server.url": { args: {}; result: string | null };
  "action.env": { args: { name: string }; result: string | null };
  "action.runQuery": { args: { name: string; args: JsonValue }; result: JsonValue };
  "action.runMutation": { args: { name: string; args: JsonValue }; result: JsonValue };
  "local.contracts": {
    args: { name: string; owner?: string };
    result: (
      | {
          plugin: string;
          registration: string;
          own: boolean;
          path?: string;
          owner: string;
          build?: string;
          unavailable?: string;
          incompatible?: never;
        }
      | { plugin: string; incompatible: true }
    )[];
  };
  "local.contract.call": {
    args: {
      plugin: string;
      owner: string;
      name: string;
      registration: string;
      method: string;
      invocationSignal?: true;
      args: JsonValue[];
    };
    result: JsonValue;
  };
  "local.contract.describe": {
    args: { plugin: string; owner: string; name: string; registration: string };
    result: { data: JsonObject; methods: string[] };
  };
  "local.contract.peer": {
    args: { channel?: number; method: string; args: JsonValue };
    result: JsonValue;
  };
  "local.contract.close": { args: { channel: number }; result: null };
  "local.contract.stopPrograms": { args: { channel: number }; result: null };
  "plugin.call": {
    args: {
      name: string;
      args: JsonValue;
      kind?: import("./functions").FunctionKind;
      contract?: string;
      on?: import("./functions").ActionTarget;
    };
    result: JsonValue;
  };
  "contract.list": {
    args: { name: string; owner?: string };
    result: { id: string; data: JsonObject; methods: Record<string, string> }[];
  };
}

export type HostOperation = keyof HostOperations;

/** Structural AbortSignal subset keeps the portable SDK free of DOM globals. */
export interface ActionSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface HostBridge {
  readonly hookPoints?: readonly string[];
  readonly pointOwner?: { name: string; declared?: readonly string[] };
  readonly call?: import("./functions").CallContext | null;
  readonly auth?: import("./functions").AuthContext | null;
  readonly user?: import("./functions").User;
  readonly signal?: ActionSignal;
  readonly retiring?: ActionSignal;
  readonly proc?: import("./local").LocalProcess;
  readonly contracts?: import("./internal/contracts").ContractScope;
  readonly channel?: {
    open(payload: HostOperations["local.contract.call"]["args"], receive: ChannelHandler): LocalChannel;
    receive(handler: ChannelHandler): void;
    send: ChannelHandler;
  };
  readonly withPrograms?: <T>(
    run: (forceStop: () => Promise<void>, host: HostBridge) => Promise<T>,
  ) => Promise<T>;
  /** Reject on errors. Values cross once, without an extra JSON string envelope. */
  op(name: HostOperation, payload: JsonValue, signal?: ActionSignal): JsonValue | Promise<JsonValue>;
}

export type ChannelHandler = (method: string, args: JsonValue) => Promise<JsonValue> | JsonValue;
export interface LocalChannel {
  readonly result: Promise<JsonValue>;
  send(method: string, args: JsonValue): Promise<JsonValue>;
  close(): Promise<void>;
  stopPrograms(): Promise<void>;
}

export type RunnerCapability = "serverContracts" | "privateFunctions";

/** Keep operation call sites tied to the contract even though the bridge is erased. */
export async function callHost<K extends HostOperation>(
  host: HostBridge,
  name: K,
  payload: HostOperations[K]["args"],
  signal?: ActionSignal,
): Promise<HostOperations[K]["result"]> {
  assertJson(payload, `${name} payload`);
  const result = await host.op(name, payload, signal);
  assertJson(result, `${name} result`);
  return result as HostOperations[K]["result"];
}
