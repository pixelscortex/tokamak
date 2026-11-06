// Database capabilities are scoped to a handler. Query objects are immutable
// plans: reusing a base builder never inherits another caller's filters/limit.
// Only terminal methods reach the host, which owns storage and atomicity.
import type { EqualityClause, HostBridge, StoredDocument } from "./host";
import { callHost } from "./host";
import type { DataModel } from "./schema";
import type { Id, JsonObject } from "./values";
import { assertId, assertJson, assertTable, isPlainObject, jsonSnapshot } from "./values";

type Table<M extends DataModel> = Extract<keyof M, string>;

export type Doc<M extends DataModel, T extends Table<M>> = M[T] & {
  _id: Id<T>;
  _creationTime: number;
};

export interface TableQuery<D extends object> {
  where<K extends Extract<keyof D, string>>(
    field: K,
    operator: "=",
    value: NoInfer<D[K]>,
  ): TableQuery<D>;
  order(direction: "asc" | "desc"): TableQuery<D>;
  take(count: number): Promise<D[]>;
  first(): Promise<D | null>;
  collect(): Promise<D[]>;
}

export interface DatabaseReader<M extends DataModel = DataModel> {
  get<T extends Table<M>>(id: Id<T>): Promise<Doc<M, T> | null>;
  query<T extends Table<M>>(table: T): TableQuery<Doc<M, T>>;
}

export interface DatabaseWriter<M extends DataModel = DataModel> extends DatabaseReader<M> {
  insert<T extends Table<M>>(table: T, value: NoInfer<M[T]>): Promise<Id<T>>;
  patch<T extends Table<M>>(id: Id<T>, value: NoInfer<Partial<M[T]>>): Promise<null>;
  replace<T extends Table<M>>(id: Id<T>, value: NoInfer<M[T]>): Promise<null>;
  delete<T extends Table<M>>(id: Id<T>): Promise<null>;
}

function document(value: unknown, table?: string): asserts value is StoredDocument {
  assertJson(value, "host document");
  if (!isPlainObject(value)) throw new Error("Host returned a non-object document");
  assertId(value._id, table);
  if (typeof value._creationTime !== "number" || !Number.isFinite(value._creationTime)) {
    throw new Error("Host document needs a finite _creationTime in epoch milliseconds");
  }
}

function writeValue(value: unknown): JsonObject {
  assertJson(value, "document");
  if (!isPlainObject(value)) throw new Error("Document must be an object");
  if (Object.hasOwn(value, "_id") || Object.hasOwn(value, "_creationTime")) {
    throw new Error("Writes cannot set _id or _creationTime");
  }
  return jsonSnapshot(value) as JsonObject;
}

function plan<D extends object>(
  host: HostBridge,
  table: string,
  where: EqualityClause[] = [],
  direction: "asc" | "desc" = "asc",
): TableQuery<D> {
  const collect = async (limit: number | null): Promise<D[]> => {
    const rows = await callHost(host, "db.query", {
      table,
      where,
      order: direction,
      limit,
    });
    if (!Array.isArray(rows)) throw new Error("Host db.query must return an array");
    for (const row of rows) document(row, table);
    if (limit !== null && rows.length > limit) throw new Error("Host db.query exceeded its limit");
    return rows as unknown as D[];
  };

  return Object.freeze({
    where<K extends Extract<keyof D, string>>(field: K, operator: "=", value: D[K]) {
      if (typeof field !== "string" || field.length === 0)
        throw new Error("Filter field must be a nonempty top-level name");
      if (operator !== "=") throw new Error("Only equality filters are supported");
      return plan<D>(
        host,
        table,
        [...where, { field, value: jsonSnapshot(value, "filter value") }],
        direction,
      );
    },
    order(order: "asc" | "desc") {
      if (order !== "asc" && order !== "desc") throw new Error("Order must be asc or desc");
      return plan<D>(host, table, where, order);
    },
    take(count: number) {
      if (!Number.isSafeInteger(count) || count < 0)
        throw new Error("take count must be a nonnegative safe integer");
      return collect(count);
    },
    async first() {
      return (await collect(1))[0] ?? null;
    },
    collect() {
      return collect(null);
    },
  });
}

/** Separate objects, not just erased TS types: a query has no write methods. */
export function createDatabase<M extends DataModel>(
  host: HostBridge,
  writable: false,
): DatabaseReader<M>;
export function createDatabase<M extends DataModel>(
  host: HostBridge,
  writable: true,
): DatabaseWriter<M>;
export function createDatabase<M extends DataModel>(
  host: HostBridge,
  writable: boolean,
): DatabaseReader<M> | DatabaseWriter<M> {
  const reader: DatabaseReader<M> = {
    async get<T extends Table<M>>(id: Id<T>): Promise<Doc<M, T> | null> {
      assertId(id);
      const row = await callHost(host, "db.get", { id });
      if (row === null) return null;
      document(row);
      if (row._id !== id) throw new Error("Host db.get returned the wrong id");
      return row as unknown as Doc<M, T>;
    },
    query(table) {
      assertTable(table);
      return plan(host, table);
    },
  };
  if (!writable) return Object.freeze(reader);
  const writer: DatabaseWriter<M> = {
    ...reader,
    async insert(table, value) {
      assertTable(table);
      const id = await callHost(host, "db.insert", {
        table,
        value: writeValue(value),
      });
      assertId(id, table);
      return id as Id<typeof table>;
    },
    async patch(id, value) {
      assertId(id);
      const result = await callHost(host, "db.patch", {
        id,
        value: writeValue(value),
      });
      if (result !== null) throw new Error("Host db.patch must return null");
      return result;
    },
    async replace(id, value) {
      assertId(id);
      const result = await callHost(host, "db.replace", {
        id,
        value: writeValue(value),
      });
      if (result !== null) throw new Error("Host db.replace must return null");
      return result;
    },
    async delete(id) {
      assertId(id);
      const result = await callHost(host, "db.delete", { id });
      if (result !== null) throw new Error("Host db.delete must return null");
      return result;
    },
  };
  return Object.freeze(writer);
}
