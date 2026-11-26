import ts from "typescript";

// Turn a finite wire type into the same validator format used for arguments.
// Open or recursive subtrees leave the surrounding type intact.
export function resultValidator(checker, definition, location) {
  const returns = definition.getProperty("returns");
  if (returns && !(returns.flags & ts.SymbolFlags.Optional)) return;
  const types = definition.getProperty("_types");
  if (!types) return;
  const carrier = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(types, location));
  const result = carrier.getProperty("result");
  if (!result) return;
  return validatorFromType(checker, checker.getTypeOfSymbolAtLocation(result, location), location);
}

export function includesUndefined(type) {
  return (
    Boolean(type.flags & ts.TypeFlags.Undefined) || (type.isUnion() && type.types.some(includesUndefined))
  );
}

export function validatorFromType(checker, type, location, point = false) {
  const visit = (type, ancestors, optional = false) => {
    if (ancestors.length >= 16 || ancestors.includes(type)) return { kind: "any" };
    const nested = [...ancestors, type];
    const flags = type.flags;
    if (type.aliasSymbol?.name === "JsonValue" || flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
      return { kind: "any" };
    if (optional && flags & ts.TypeFlags.Undefined) return { kind: "never" };
    if (flags & ts.TypeFlags.Never) return { kind: "never" };
    if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return { kind: "null" };
    if (flags & ts.TypeFlags.Boolean) return { kind: "boolean" };
    if (flags & ts.TypeFlags.BooleanLiteral) return { kind: "literal", value: type.intrinsicName === "true" };
    if (type.isLiteral()) return { kind: "literal", value: type.value };
    if (flags & ts.TypeFlags.String) return { kind: "string" };
    if (flags & ts.TypeFlags.Number) return { kind: "number" };
    if (type.isUnion()) {
      const members = type.types
        .filter((member) => !optional || !(member.flags & ts.TypeFlags.Undefined))
        .map((member) => visit(member, nested));
      return { kind: "union", members };
    }
    if (checker.isTupleType(type)) {
      return {
        kind: "tuple",
        items: checker.getTypeArguments(type).map((item, index) => {
          const flags = type.target.elementFlags[index];
          return {
            value: visit(item, nested, Boolean(flags & ts.ElementFlags.Optional)),
            optional: Boolean(flags & ts.ElementFlags.Optional),
            rest: Boolean(flags & ts.ElementFlags.Rest),
          };
        }),
      };
    }
    if (checker.isArrayType(type)) {
      const item = visit(checker.getTypeArguments(type)[0], nested);
      return { kind: "array", item };
    }
    if (type.isIntersection() && type.types.some((member) => member.flags & ts.TypeFlags.String)) {
      const brand = type.getProperty("__table");
      if (brand) {
        const table = checker.getTypeOfSymbolAtLocation(brand, location);
        if (table.isStringLiteral()) return { kind: "id", table: table.value };
      }
      return { kind: "string" };
    }
    if (!(flags & ts.TypeFlags.Object || type.isIntersection())) return { kind: "any" };
    if (checker.getIndexInfosOfType(type).length) return { kind: "any" };
    if (type.getCallSignatures().length) return { kind: "any" };

    const fields = [];
    for (const field of type.getProperties()) {
      if (field.name.startsWith("__@")) continue;
      const fieldType = checker.getTypeOfSymbolAtLocation(field, location);
      const optional = field.flags & ts.SymbolFlags.Optional || (point && includesUndefined(fieldType));
      const inner = visit(fieldType, nested, Boolean(optional));
      fields.push([field.name, optional ? { kind: "optional", inner } : inner]);
    }
    return fields.length || point ? { kind: "object", fields: Object.fromEntries(fields) } : { kind: "any" };
  };
  return visit(type, []);
}
