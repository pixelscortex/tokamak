import ts from "typescript";

// Turn a finite wire type into the same validator format used for arguments.
// Open or recursive types fall back to the shape of the actual query result.
export function resultValidator(checker, definition, location) {
  const types = definition.getProperty("_types");
  if (!types) return;
  const carrier = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(types, location));
  const result = carrier.getProperty("result");
  if (!result) return;
  const visit = (type, ancestors) => {
    if (ancestors.length >= 16 || ancestors.includes(type)) return;
    const nested = [...ancestors, type];
    const flags = type.flags;
    if (flags & ts.TypeFlags.Never) return { kind: "never" };
    if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Null)) return { kind: "null" };
    if (flags & ts.TypeFlags.Boolean) return { kind: "boolean" };
    if (flags & ts.TypeFlags.BooleanLiteral) return { kind: "literal", value: type.intrinsicName === "true" };
    if (type.isLiteral()) return { kind: "literal", value: type.value };
    if (flags & ts.TypeFlags.String) return { kind: "string" };
    if (flags & ts.TypeFlags.Number) return { kind: "number" };
    if (type.isUnion()) {
      const members = type.types.map((member) => visit(member, nested));
      if (members.every(Boolean)) return { kind: "union", members };
      return;
    }
    if (checker.isTupleType(type)) return;
    if (checker.isArrayType(type)) {
      const item = visit(checker.getTypeArguments(type)[0], nested);
      if (item) return { kind: "array", item };
      return;
    }
    if (type.isIntersection() && type.types.some((member) => member.flags & ts.TypeFlags.String)) {
      const brand = type.getProperty("__table");
      if (brand) {
        const table = checker.getTypeOfSymbolAtLocation(brand, location);
        if (table.isStringLiteral()) return { kind: "id", table: table.value };
      }
      return { kind: "string" };
    }
    if (!(flags & ts.TypeFlags.Object || type.isIntersection())) return;
    if (checker.getIndexInfosOfType(type).length || type.getCallSignatures().length) return;

    const fields = [];
    for (const field of type.getProperties()) {
      if (field.name.startsWith("__@")) continue;
      const fieldType = checker.getTypeOfSymbolAtLocation(field, location);
      const optional = field.flags & ts.SymbolFlags.Optional;
      const inner = visit(optional ? checker.getNonOptionalType(fieldType) : fieldType, nested);
      if (!inner) return;
      fields.push([field.name, optional ? { kind: "optional", inner } : inner]);
    }
    return { kind: "object", fields: Object.fromEntries(fields) };
  };
  return visit(checker.getTypeOfSymbolAtLocation(result, location), []);
}
