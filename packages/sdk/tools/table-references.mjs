import ts from "typescript";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pluginCompilerOptions } from "./plugin-compiler.mjs";
import { serverDirectory } from "./server-files.mjs";

const quote = JSON.stringify;

/** Read inferred schema types without executing the owner's code. */
export function tableReferences(folder, owner, config) {
  const entry = resolve(serverDirectory(folder), "schema.ts");
  if (!existsSync(entry)) return [];
  const program = ts.createProgram([entry], pluginCompilerOptions(folder, config));
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const module = checker.getSymbolAtLocation(source);
  const schema = module && checker.getExportsOfModule(module).find((symbol) => symbol.name === "default");
  const tables = schema && checker.getTypeOfSymbolAtLocation(schema, source).getProperty("tables");
  const typeOf = (symbol) => checker.getTypeOfSymbolAtLocation(symbol, source);

  function render(type, omitUndefined = false, ancestors = new Set()) {
    if (type.aliasSymbol?.name === "Id") {
      const argument = type.aliasTypeArguments[0];
      const members = argument.isUnion() ? argument.types : [argument];
      const names = members.map((member) =>
        member.isStringLiteral() && !member.value.includes(".")
          ? quote(`${owner}.${member.value}`)
          : checker.typeToString(member),
      );
      return `Id<${names.join(" | ")}>`;
    }
    if (type.aliasSymbol?.name === "JsonValue") return "JsonValue";
    if (type.isUnion() || type.isIntersection()) {
      const members = type.types.filter(
        (member) => !omitUndefined || !(member.flags & ts.TypeFlags.Undefined),
      );
      if (members.length === 1) return render(members[0], false, ancestors);
      return (
        members.map((member) => render(member, false, ancestors)).join(type.isUnion() ? " | " : " & ") ||
        "never"
      );
    }
    if (!(type.flags & ts.TypeFlags.Object)) return checker.typeToString(type);
    if (ancestors.has(type)) throw new Error(`Plugin ${owner}: recursive table field types cannot be copied`);
    return renderObject(type, new Set(ancestors).add(type));
  }

  function renderObject(type, ancestors) {
    const args = checker.getTypeArguments(type);
    if (checker.isArrayType(type)) return `Array<${render(args[0], false, ancestors)}>`;
    if (checker.isTupleType(type))
      return `[${args.map((item) => render(item, false, ancestors)).join(", ")}]`;
    const properties = type.getProperties().map((property) => {
      const optional = Boolean(property.flags & ts.SymbolFlags.Optional);
      return `${quote(property.name)}${optional ? "?" : ""}: ${render(typeOf(property), optional, ancestors)}`;
    });
    const index = type.getStringIndexType();
    if (index) properties.push(`[key: string]: ${render(index, false, ancestors)}`);
    return `{ ${properties.join("; ")} }`;
  }

  return (tables ? typeOf(tables).getProperties() : []).map((table) => {
    const fields = typeOf(table).getProperty("fields");
    const document = (fields ? typeOf(fields).getProperties() : []).map((field) => {
      const validator = typeOf(field);
      const optional = validator.getProperty("optional");
      const value = validator.getProperty("_type");
      const fieldType = value ? render(typeOf(value), true) : "never";
      return `${quote(field.name)}${optional && checker.typeToString(typeOf(optional)) === "true" ? "?" : ""}: ${fieldType}`;
    });
    return { name: table.name, qualified: `${owner}.${table.name}`, document: `{ ${document.join("; ")} }` };
  });
}

export function tableDeclarations(owner, tables, allowed) {
  // Preserve the owner in missing-property diagnostics, even when it exports no tables.
  return (
    '// Generated table handles. Do not edit.\nimport type { Id, JsonValue, TableReference } from "@tokamak/sdk";\n' +
    `export declare const tables: {\n  readonly [Symbol.toStringTag]?: ${quote(owner)};\n` +
    tables
      .map(
        ({ name, qualified, document }) =>
          `  readonly ${quote(name)}: ${
            allowed
              ? `TableReference<${quote(qualified)}, ${document}>`
              : `{ readonly ${quote(`Declare ${owner} in depends to reference ${qualified}`)}: never }`
          };\n`,
      )
      .join("") +
    "};\n"
  );
}

export function tableReferenceSource(tables) {
  return `export const tables = Object.freeze({${tables
    .map(({ name, qualified }) => `[${quote(name)}]: Object.freeze({ qualifiedName: ${quote(qualified)} })`)
    .join(",")}});\n`;
}
