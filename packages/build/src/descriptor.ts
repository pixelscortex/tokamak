import { readPluginCompilerOptions } from "../../sdk/tools/plugin-boundary.mjs";
/** Static package conventions. Never import or evaluate an authored descriptor. */
import { isServerModule } from "../../sdk/tools/server-files.mjs";
import ts from "typescript";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import type { PluginDefinition } from "@tokamak/sdk";

export function serverDirectory(root: string): string {
  return resolve(root, existsSync(resolve(root, "src/server")) ? "src/server" : "backend");
}
export function serverModule(root: string, module: string): string {
  return existsSync(resolve(root, "src/server")) ? basename(module) : module;
}
export function clientEntry(root: string): string {
  for (const entry of ["src/client/api.ts", "src/client/api.tsx", "src/client/main.tsx", "src/main.tsx"])
    if (existsSync(resolve(root, entry))) return resolve(root, entry);
  return resolve(root, existsSync(resolve(root, "src/client")) ? "src/client/main.tsx" : "src/main.tsx");
}

export function readDescriptor(root: string): PluginDefinition | undefined {
  const path = resolve(root, "plugin.ts");
  if (!existsSync(path)) return;
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const fail = (): never => {
    throw new Error("plugin.ts must export default definePlugin({...}) with static literal metadata");
  };
  const helper = source.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === "@tokamak/sdk" &&
    statement.importClause?.namedBindings &&
    ts.isNamedImports(statement.importClause.namedBindings)
      ? statement.importClause.namedBindings.elements
          .filter((e) => (e.propertyName ?? e.name).text === "definePlugin")
          .map((e) => e.name.text)
      : [],
  );
  const assignment = source.statements.find(ts.isExportAssignment);
  if (!assignment || assignment.isExportEquals || !ts.isCallExpression(assignment.expression)) return fail();
  const call = assignment.expression;
  if (
    !ts.isIdentifier(call.expression) ||
    !helper.includes(call.expression.text) ||
    call.arguments.length !== 1
  )
    return fail();
  function literal(node: ts.Node): unknown {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, unknown> = {};
      for (const property of node.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        )
          return fail();
        const key = property.name.text;
        if (Object.hasOwn(result, key)) return fail();
        result[key] = literal(property.initializer);
      }
      return result;
    }
    return fail();
  }
  const value = literal(call.arguments[0]!) as Record<string, unknown>;
  const allowed = [
    "id",
    "version",
    "name",
    "description",
    "depends",
    "optional",
    "permissions",
    "runtime",
    "maintenance",
  ];
  if (!value || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    return fail();
  for (const key of ["depends", "optional"]) {
    if (value[key] === undefined) continue;
    const ids = value[key];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length)
      return fail();
    value[key] = Object.fromEntries(ids.map((id) => [id, "*"]));
  }
  return value as unknown as PluginDefinition;
}

/** The existing backend protocol has three public actions. Derive its provider
 * from those exports; derive consumers from literal ctx.providers calls. */
export function deriveInterfaces(root: string) {
  const consumes = new Set<string>();
  const server = serverDirectory(root);
  if (!existsSync(server)) return {};
  function visitDirectory(directory: string) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, item.name);
      if (item.isDirectory()) {
        if (isServerModule(server, relative(server, resolve(path, "module.ts")).split(sep).join("/")))
          visitDirectory(path);
      } else if (isServerModule(server, relative(server, path).split(sep).join("/"))) {
        const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
        function visit(node: ts.Node) {
          if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "providers"
          ) {
            const name = node.arguments[0];
            if (name && ts.isStringLiteralLike(name)) consumes.add(name.text);
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  visitDirectory(server);
  return { consumes: [...consumes].sort() };
}

/** Match dependency contracts against public, generated SDK references without
 * evaluating provider code. Arguments are contravariant; results are covariant. */
export function deriveProviders(root: string, plugin: PluginDefinition, functions: string[]): string[] {
  const provides = new Set<string>();
  for (const id of Object.keys(plugin.depends ?? {})) {
    const entry = resolve(root, "..", id, "src/server/api.ts");
    if (!existsSync(entry)) continue;
    const apiPath = resolve(serverDirectory(root), "_generated/api.ts");
    if (!existsSync(apiPath)) continue;
    const program = ts.createProgram(
      [entry, apiPath],
      readPluginCompilerOptions(root, serverDirectory(root)),
    );
    const checker = program.getTypeChecker();
    const apiFile = program.getSourceFile(apiPath)!;
    const apiModule = checker.getSymbolAtLocation(apiFile);
    const api = apiModule && checker.getExportsOfModule(apiModule).find((symbol) => symbol.name === "api");
    if (!api) continue;
    const provider = checker.getTypeOfSymbolAtLocation(api, apiFile);
    const file = program.getSourceFile(entry)!;
    const module = checker.getSymbolAtLocation(file);
    for (const exported of module ? checker.getExportsOfModule(module) : []) {
      if (!exported.name.endsWith("Api")) continue;
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const type = checker.getDeclaredTypeOfSymbol(target);
      for (const member of type.getProperties()) {
        const declaration = member.valueDeclaration ?? member.declarations?.[0];
        if (!declaration) continue;
        const methods = checker.getTypeOfSymbolAtLocation(member, declaration).getProperties();
        const implementation = provider.getProperty(member.name);
        if (!implementation) continue;
        const moduleType = checker.getTypeOfSymbolAtLocation(implementation, apiFile);
        if (
          methods.length &&
          methods.every((method) => {
            if (!functions.includes(`${member.name}:${method.name}`)) return false;
            const actual = moduleType.getProperty(method.name);
            if (!actual) return false;
            return compatibleReference(
              checker,
              checker.getTypeOfSymbolAtLocation(actual, apiFile),
              checker.getTypeOfSymbolAtLocation(method, declaration),
              declaration,
            );
          })
        )
          provides.add(`${id}.${member.name}`);
      }
    }
  }
  return [...provides].sort();
}

function compatibleReference(checker: ts.TypeChecker, actual: ts.Type, expected: ts.Type, node: ts.Node) {
  function payload(type: ts.Type) {
    const brand = type.getProperties().find((property) => property.name.startsWith("__@referenceTypes@"));
    return brand && checker.getTypeOfSymbolAtLocation(brand, node);
  }
  const source = payload(actual);
  const target = payload(expected);
  if (!source || !target) return false;
  return ["kind", "args", "result"].every((name) => {
    const a = source.getProperty(name);
    const b = target.getProperty(name);
    if (!a || !b) return false;
    const actualType = checker.getTypeOfSymbolAtLocation(a, node);
    const expectedType = checker.getTypeOfSymbolAtLocation(b, node);
    // An unresolved contract must never advertise a provider.
    if ((actualType.flags | expectedType.flags) & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
    return name === "args"
      ? checker.isTypeAssignableTo(expectedType, actualType)
      : checker.isTypeAssignableTo(actualType, expectedType);
  });
}
