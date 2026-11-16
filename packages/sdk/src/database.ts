// Database capabilities are scoped to a handler. Query objects are immutable
// plans: reusing a base builder never inherits another caller's filters/limit.
// Only terminal methods reach the host, which owns storage and atomicity.
import type { EqualityClause, HostBridge, IndexQuery, RangeClause, StoredDocument } from "./host";
import { callHost } from "./host";
import type { DataModel, Indexes, IndexesFor, SchemaDefinition } from "./schema";
import { assertIndexName } from "./schema";
import type { Fields } from "./validators";
import { validate } from "./validators";
import type { Id, JsonObject } from "./values";
import { assertId, assertJson, assertTable, isPlainObject, jsonSnapshot } from "./values";

type Table<M extends DataModel> = Extract<keyof M, string>;

export type Doc<M extends DataModel, T extends Table<M>> = M[T] & {
  _id: Id<T>;
  _creationTime: number;
};

declare const rangeType: unique symbol;
export interface IndexBounds {
  readonly [rangeType]: true;
}
type FieldValue<D, K extends string> = K extends keyof D ? D[K] : never;
type Lower<D, K extends string, R> = {
  gt(field: K, value: NoInfer<FieldValue<D, K>>): R;
  gte(field: K, value: NoInfer<FieldValue<D, K>>): R;
};
type Upper<D, K extends string, R> = {
  lt(field: K, value: NoInfer<FieldValue<D, K>>): R;
  lte(field: K, value: NoInfer<FieldValue<D, K>>): R;
};
export type IndexRange<D, F extends readonly string[]> = IndexBounds &
  (F extends readonly [infer K extends string, ...infer Rest extends string[]]
    ? { eq(field: K, value: NoInfer<FieldValue<D, K>>): IndexRange<D, Rest> } & Lower<
        D,
        K,
        IndexBounds & Upper<D, K, IndexBounds>
      > &
        Upper<D, K, IndexBounds & Lower<D, K, IndexBounds>>
    : number extends F["length"]
      ? { eq<K extends Extract<keyof D, string>>(field: K, value: NoInfer<D[K]>): IndexRange<D, F> } & Lower<
          D,
          Extract<keyof D, string>,
          IndexBounds & Upper<D, Extract<keyof D, string>, IndexBounds>
        > &
          Upper<D, Extract<keyof D, string>, IndexBounds & Lower<D, Extract<keyof D, string>, IndexBounds>>
      : Record<never, never>);

export interface QueryResult<D extends object> {
  order(direction: "asc" | "desc"): QueryResult<D>;
  take(count: number): Promise<D[]>;
  first(): Promise<D | null>;
  collect(): Promise<D[]>;
}
// A query that already has a `where` filter. It has no `withIndex`: filters and
// an index cannot be mixed (the host rejects it), so the type removes the
// method instead of letting the chain compile and fail at runtime.
export interface FilteredQuery<D extends object> extends QueryResult<D> {
  where<K extends Extract<keyof D, string>>(field: K, operator: "=", value: NoInfer<D[K]>): FilteredQuery<D>;
  order(direction: "asc" | "desc"): FilteredQuery<D>;
}
export interface TableQuery<D extends object, I extends Indexes = Indexes> extends QueryResult<D> {
  where<K extends Extract<keyof D, string>>(field: K, operator: "=", value: NoInfer<D[K]>): FilteredQuery<D>;
  order(direction: "asc" | "desc"): TableQuery<D, I>;
  withIndex<N extends Extract<keyof I, string>>(
    name: N,
    range?: (q: IndexRange<D, I[N]>) => IndexBounds,
  ): QueryResult<D>;
}

export interface DatabaseReader<M extends DataModel = DataModel> {
  get<T extends Table<M>>(id: Id<T>): Promise<Doc<M, T> | null>;
  query<T extends Table<M>>(table: T): TableQuery<Doc<M, T>, IndexesFor<M, T>>;
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

const rangeState = Symbol("tokamak.indexRange");
interface RangeState {
  owner: object;
  eq: EqualityClause[];
  range: RangeClause[];
}
function indexRange(state: RangeState, fields?: readonly string[], validators?: Fields): object {
  const append = (operator: "eq" | RangeClause["operator"], field: string, value: unknown) => {
    if (typeof field !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field))
      throw new Error("Index field must be a single ASCII identifier");
    if (fields && fields[state.eq.length] !== field)
      throw new Error(
        operator === "eq"
          ? "Index equalities must follow its leading field order"
          : "Index range must constrain the field after the equality prefix",
      );
    const snapshot = jsonSnapshot(value, "index value");
    if (validators?.[field]) validate(validators[field].description, snapshot, `index ${field}`);
    if (operator === "eq") {
      if (state.range.length) throw new Error("Cannot add equality after an index range");
      if (state.eq.some((clause) => clause.field === field)) throw new Error("Repeated index equality field");
      return indexRange({ ...state, eq: [...state.eq, { field, value: snapshot }] }, fields, validators);
    }
    const lower = operator === "gt" || operator === "gte";
    if (
      state.eq.some((clause) => clause.field === field) ||
      state.range.some((clause) => clause.field !== field)
    )
      throw new Error("Index range must constrain the field after the equality prefix");
    if (state.range.some((clause) => (clause.operator === "gt" || clause.operator === "gte") === lower))
      throw new Error("An index range accepts one lower and one upper bound");
    return indexRange(
      { ...state, range: [...state.range, { field, operator, value: snapshot }] },
      fields,
      validators,
    );
  };
  return Object.freeze({
    [rangeState]: state,
    eq: (field: string, value: unknown) => append("eq", field, value),
    gt: (field: string, value: unknown) => append("gt", field, value),
    gte: (field: string, value: unknown) => append("gte", field, value),
    lt: (field: string, value: unknown) => append("lt", field, value),
    lte: (field: string, value: unknown) => append("lte", field, value),
  });
}

function plan<D extends object, I extends Indexes = Indexes>(
  host: HostBridge,
  table: string,
  where: EqualityClause[] = [],
  direction: "asc" | "desc" = "asc",
  schema?: SchemaDefinition,
  index?: IndexQuery,
): TableQuery<D, I> {
  const collect = async (limit: number | null): Promise<D[]> => {
    const rows = await callHost(host, "db.query", {
      table,
      where,
      order: direction,
      limit,
      ...(index ? { index } : {}),
    });
    if (!Array.isArray(rows)) throw new Error("Host db.query must return an array");
    for (const row of rows) document(row, table);
    if (limit !== null && rows.length > limit) throw new Error("Host db.query exceeded its limit");
    return rows as unknown as D[];
  };

  return Object.freeze({
    where<K extends Extract<keyof D, string>>(field: K, operator: "=", value: D[K]) {
      if (index) throw new Error("where cannot be combined with withIndex");
      if (typeof field !== "string" || field.length === 0)
        throw new Error("Filter field must be a nonempty top-level name");
      if (operator !== "=") throw new Error("Only equality filters are supported");
      return plan<D, I>(
        host,
        table,
        [...where, { field, value: jsonSnapshot(value, "filter value") }],
        direction,
        schema,
      );
    },
    order(order: "asc" | "desc") {
      if (order !== "asc" && order !== "desc") throw new Error("Order must be asc or desc");
      return plan<D, I>(host, table, where, order, schema, index);
    },
    withIndex(name: string, range?: (q: IndexRange<D, readonly string[]>) => IndexBounds) {
      assertIndexName(name);
      if (index || where.length) throw new Error("withIndex must be selected once before any where filters");
      const definition = schema?.tables[table]?.indexes.find((index) => index.name === name);
      if (schema && !definition) throw new Error(`Unknown index on ${table}: ${name}`);
      if (range !== undefined && typeof range !== "function")
        throw new Error("Index range must be a callback");
      const owner = {};
      const base = indexRange(
        { owner, eq: [], range: [] },
        definition?.fields,
        schema?.tables[table]?.fields,
      );
      const result = range ? range(base as IndexRange<D, readonly string[]>) : base;
      const state = (result as { [rangeState]?: RangeState } | null)?.[rangeState];
      if (!state || state.owner !== owner) throw new Error("Index callback must return its range builder");
      return plan<D, I>(host, table, [], direction, schema, { name, eq: state.eq, range: state.range });
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
  }) as unknown as TableQuery<D, I>;
}

/** Separate objects, not just erased TS types: a query has no write methods. */
export function createDatabase<M extends DataModel>(
  host: HostBridge,
  writable: false,
  schema?: SchemaDefinition,
): DatabaseReader<M>;
export function createDatabase<M extends DataModel>(
  host: HostBridge,
  writable: true,
  schema?: SchemaDefinition,
): DatabaseWriter<M>;
export function createDatabase<M extends DataModel>(
  host: HostBridge,
  writable: boolean,
  schema?: SchemaDefinition,
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
      return plan<Doc<M, typeof table>, IndexesFor<M, typeof table>>(host, table, [], "asc", schema);
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
