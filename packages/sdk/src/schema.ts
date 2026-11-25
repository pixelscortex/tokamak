// Schemas provide authoring types and install index and reference metadata.
// General field validation and migrations remain deferred.
import { assertTable } from "./values";
import type { Fields, ObjectValue, TableField, ValidatorDescription } from "./validators";
import { containsRef, v } from "./validators";

export interface IndexDefinition<F extends readonly string[] = readonly string[]> {
  readonly name: string;
  readonly fields: F;
  readonly unique: boolean;
}
export type Indexes = Record<string, readonly string[]>;

export interface TableDefinition<F extends Fields = Fields, I extends Indexes = Indexes> {
  readonly fields: F;
  readonly description: ValidatorDescription;
  readonly indexes: readonly IndexDefinition[];
  index<N extends string, const K extends readonly [Extract<keyof F, string>, ...Extract<keyof F, string>[]]>(
    name: N,
    fields: K,
  ): TableDefinition<F, I & Record<N, K>>;
  unique<
    N extends string,
    const K extends readonly [Extract<keyof F, string>, ...Extract<keyof F, string>[]],
  >(
    name: N,
    fields: K,
  ): TableDefinition<F, I & Record<N, K>>;
  readonly _indexes?: I;
}

export interface SchemaDefinition<
  T extends Record<string, TableDefinition> = Record<string, TableDefinition>,
> {
  readonly tables: T;
}
export type DataModel = Record<string, object>;
// Metadata lives on the model, never on stored documents or writable fields.
declare const schemaIndexes: unique symbol;
export type ModelFromSchema<S extends SchemaDefinition> = {
  [T in keyof S["tables"]]: ObjectValue<S["tables"][T]["fields"]>;
} & {
  readonly [schemaIndexes]: {
    [T in keyof S["tables"]]: NonNullable<S["tables"][T]["_indexes"]>;
  };
};
export type IndexesFor<M extends DataModel, T extends keyof M> = M extends {
  readonly [schemaIndexes]: infer I;
}
  ? T extends keyof I
    ? Extract<I[T], Indexes>
    : never
  : Indexes;

// The server enforces the same caps when a plugin loads (schema.rs); checking
// here reports the mistake at the declaration instead of at install.
const MAX_INDEXES_PER_TABLE = 32;
const MAX_INDEX_FIELDS = 16;
const MAX_NAME_LENGTH = 64;

export function assertIndexName(name: string): void {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error("Index name must match [A-Za-z_][A-Za-z0-9_]*");
  }
  if (name.length > MAX_NAME_LENGTH)
    throw new Error(`Index name is longer than ${MAX_NAME_LENGTH} characters`);
}

export function defineTable<F extends Fields>(
  fields: F & { [K in keyof F]: TableField<F[K]> },
): TableDefinition<F, Record<never, never>> {
  if (Object.hasOwn(fields, "_id") || Object.hasOwn(fields, "_creationTime")) {
    throw new Error("Table fields cannot declare _id or _creationTime: the host owns them");
  }
  for (const { description } of Object.values<Fields[string]>(fields)) {
    const field = description.kind === "optional" ? description.inner : description;
    if (field.kind !== "ref" && containsRef(field))
      throw new Error("A ref must be a top-level field (optional allowed)");
  }

  const snapshot: F = Object.freeze({ ...fields });
  const description = v.object(snapshot).description;
  const table = (indexes: readonly IndexDefinition[]): TableDefinition<F, Indexes> => {
    const add = (name: string, keys: readonly string[], unique: boolean) => {
      assertIndexName(name);
      if (indexes.some((index) => index.name === name)) throw new Error(`Duplicate index: ${name}`);
      if (!Array.isArray(keys) || keys.length === 0) throw new Error("An index needs at least one field");
      if (keys.length > MAX_INDEX_FIELDS) throw new Error(`An index has at most ${MAX_INDEX_FIELDS} fields`);
      if (indexes.length >= MAX_INDEXES_PER_TABLE)
        throw new Error(`A table has at most ${MAX_INDEXES_PER_TABLE} indexes`);
      const seen = new Set<string>();
      for (const key of keys) {
        if (typeof key !== "string" || !Object.hasOwn(snapshot, key))
          throw new Error(`Undeclared index field: ${key}`);
        // The native value index API accepts single ASCII identifiers only.
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid index field: ${key}`);
        if (seen.has(key)) throw new Error(`Repeated index field: ${key}`);
        seen.add(key);
      }
      return table(
        Object.freeze([...indexes, Object.freeze({ name, fields: Object.freeze([...keys]), unique })]),
      );
    };
    return Object.freeze({
      fields: snapshot,
      description,
      indexes,
      index: (name: string, keys: readonly string[]) => add(name, keys, false),
      unique: (name: string, keys: readonly string[]) => add(name, keys, true),
    }) as TableDefinition<F, Indexes>;
  };
  return table(Object.freeze([])) as TableDefinition<F, Record<never, never>>;
}

export function defineSchema<T extends Record<string, TableDefinition>>(tables: T): SchemaDefinition<T> {
  for (const table of Object.keys(tables)) assertTable(table);
  return Object.freeze({ tables: Object.freeze({ ...tables }) });
}

/** Inspect the same schema as handlers, without serializing builder methods. */
export function schemaMetadata(schema: SchemaDefinition | null) {
  return {
    tables: Object.fromEntries(
      Object.entries(schema?.tables ?? {}).map(([name, table]) => [
        name,
        { description: table.description, indexes: table.indexes },
      ]),
    ),
  };
}
