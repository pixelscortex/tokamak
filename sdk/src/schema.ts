// Schemas describe tables for authoring types and host metadata. Persistence
// enforcement and migrations are deferred; this module does not pretend to
// install database constraints, nor accept an index it cannot implement.
import { assertTable } from "./values";
import type { Fields, ObjectValue, ValidatorDescription } from "./validators";
import { v } from "./validators";

export interface TableDefinition<F extends Fields = Fields> {
  readonly fields: F;
  readonly description: ValidatorDescription;
}

export interface SchemaDefinition<
  T extends Record<string, TableDefinition> = Record<string, TableDefinition>,
> {
  readonly tables: T;
}
export type DataModel = Record<string, object>;

export type ModelFromSchema<S extends SchemaDefinition> = {
  [T in keyof S["tables"]]: ObjectValue<S["tables"][T]["fields"]>;
};

export function defineTable<F extends Fields>(fields: F): TableDefinition<F> {
  if (Object.hasOwn(fields, "_id") || Object.hasOwn(fields, "_creationTime")) {
    throw new Error("Table fields cannot declare _id or _creationTime: the host owns them");
  }
  const snapshot = Object.freeze({ ...fields });
  return Object.freeze({
    fields: snapshot,
    description: v.object(snapshot).description,
  });
}

export function defineSchema<T extends Record<string, TableDefinition>>(
  tables: T,
): SchemaDefinition<T> {
  for (const table of Object.keys(tables)) assertTable(table);
  return Object.freeze({ tables: Object.freeze({ ...tables }) });
}
