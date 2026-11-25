/** Static package conventions. Never import or evaluate an authored descriptor. */
import ts from "typescript";
import { basename, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { PluginDefinition } from "@tokamak/sdk";
export { clientEntry } from "../../sdk/tools/plugin-boundary.mjs";

export function serverModule(root: string, module: string): string {
  return existsSync(resolve(root, "src/server")) ? basename(module) : module;
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
