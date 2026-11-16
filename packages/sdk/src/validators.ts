// Validators retain a serializable description for host metadata and an inferred
// TypeScript type. Validation is deliberately non-transforming: wire and handler
// arguments mean the same thing, unlike general-purpose schema adapters.
import { assertId, assertJson, assertTable, isPlainObject } from "./values";
import type { Id, JsonValue } from "./values";

export type ValidatorDescription =
  | { kind: "string" | "number" | "boolean" | "null" | "any" }
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "id"; table: string }
  | { kind: "array"; item: ValidatorDescription }
  | { kind: "optional"; inner: ValidatorDescription }
  | { kind: "object"; fields: Record<string, ValidatorDescription> }
  | { kind: "union"; members: ValidatorDescription[] };

export interface Validator<T, Optional extends boolean = false> {
  readonly description: ValidatorDescription;
  readonly optional: Optional;
  readonly _type?: T;
}

export type Fields = Record<string, Validator<unknown, boolean>>;

export type Infer<V> = V extends Validator<infer T, boolean> ? T : never;

type OptionalKeys<F extends Fields> = {
  [K in keyof F]: F[K] extends Validator<unknown, true> ? K : never;
}[keyof F];

export type ObjectValue<F extends Fields> = keyof F extends never
  ? Record<string, never>
  : { [K in Exclude<keyof F, OptionalKeys<F>>]: Infer<F[K]> } & {
      [K in OptionalKeys<F>]?: Infer<F[K]>;
    };

function freezeDescription(description: ValidatorDescription): ValidatorDescription {
  if (description.kind === "array") freezeDescription(description.item);
  if (description.kind === "optional") freezeDescription(description.inner);
  if (description.kind === "object") {
    for (const field of Object.values(description.fields)) freezeDescription(field);
    Object.freeze(description.fields);
  }
  if (description.kind === "union") {
    for (const member of description.members) freezeDescription(member);
    Object.freeze(description.members);
  }
  return Object.freeze(description);
}

function validator<T>(description: ValidatorDescription): Validator<T> {
  return Object.freeze({
    description: freezeDescription(description),
    optional: false,
  });
}

export const v = {
  string: () => validator<string>({ kind: "string" }),
  number: () => validator<number>({ kind: "number" }),
  boolean: () => validator<boolean>({ kind: "boolean" }),
  null: () => validator<null>({ kind: "null" }),

  // "any" means any JSON value, never TypeScript any or host-specific objects.
  any: () => validator<JsonValue>({ kind: "any" }),
  literal<const T extends string | number | boolean | null>(value: T): Validator<T> {
    assertJson(value, "literal");
    return validator({ kind: "literal", value });
  },
  id<T extends string>(table: T): Validator<Id<T>> {
    assertTable(table);
    return validator({ kind: "id", table });
  },
  array<T>(item: Validator<T>): Validator<T[]> {
    return validator({ kind: "array", item: item.description });
  },
  object<F extends Fields>(fields: F): Validator<ObjectValue<F>> {
    return validator({
      kind: "object",
      fields: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.description])),
    });
  },

  optional<T>(inner: Validator<T>): Validator<T, true> {
    return Object.freeze({
      description: freezeDescription({
        kind: "optional",
        inner: inner.description,
      }),
      optional: true,
    });
  },
  union<V extends readonly [Validator<unknown>, ...Validator<unknown>[]]>(
    ...members: V
  ): Validator<Infer<V[number]>> {
    return validator({
      kind: "union",
      members: members.map((member) => member.description),
    });
  },
};

/** Optional means an absent object key; explicit undefined is never a wire value. */
export function validate(description: ValidatorDescription, value: unknown, path = "args"): void {
  const fail = (expected: string): never => {
    throw new Error(`${path}: expected ${expected}`);
  };
  switch (description.kind) {
    case "any":
      assertJson(value, path);
      return;
    case "optional":
      validate(description.inner, value, path);
      return;
    case "array":
      if (!Array.isArray(value)) return fail("array");
      for (let i = 0; i < value.length; i++) validate(description.item, value[i], `${path}[${i}]`);
      return;
    case "object":
      validateObject(description.fields, value, path);
      return;
    case "union":
      for (const member of description.members) {
        try {
          validate(member, value, path);
          return;
        } catch {
          /* Try the next alternative. */
        }
      }
      fail("one of the declared union members");
    default:
      validateScalar(description, value, path);
  }
}

function validateObject(fields: Record<string, ValidatorDescription>, value: unknown, path: string) {
  if (!isPlainObject(value)) throw new Error(`${path}: expected object`);
  for (const [key, field] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) {
      if (field.kind !== "optional") throw new Error(`${path}.${key}: required field is missing`);
    } else validate(field, value[key], `${path}.${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) throw new Error(`${path}.${key}: unexpected field`);
  }
}

function validateScalar(description: ValidatorDescription, value: unknown, path: string) {
  const fail = (expected: string): never => {
    throw new Error(`${path}: expected ${expected}`);
  };
  switch (description.kind) {
    case "string":
      if (typeof value !== "string") fail("string");
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail("finite number");
      return;
    case "boolean":
      if (typeof value !== "boolean") fail("boolean");
      return;
    case "null":
      if (value !== null) fail("null");
      return;
    case "literal":
      if (value !== description.value) fail(JSON.stringify(description.value));
      return;
    case "id":
      try {
        assertId(value, description.table);
      } catch {
        fail(`id of table ${description.table}`);
      }
      return;
  }
}
