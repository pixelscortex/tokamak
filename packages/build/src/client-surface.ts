import { dirname } from "node:path";
import { readPluginCompilerOptions } from "../../sdk/tools/plugin-boundary.mjs";
import { clientEntry } from "./descriptor.ts";
/** Public client declarations come from the entry's symbol graph, never a
 * runtime scan. This also intercepts calls inside the declaring plugin. */
import ts from "typescript";
import { normalizePath } from "vite";
import MagicString from "magic-string";
import type { Plugin } from "vite";

export function clientSurface(root: () => string, pluginId: () => string): Plugin {
  let declarations: Map<string, Map<string, string[]>>;
  let program: ts.Program;
  let checker: ts.TypeChecker;
  const slotHelpers = new Set<ts.Symbol>();
  return {
    name: "tokamak-client-surface",
    enforce: "pre",
    transform(code, id) {
      id = normalizePath(id);
      if (!id.startsWith(normalizePath(root()) + "/src/") || !/\.tsx?$/.test(id)) return;
      if (!declarations) {
        declarations = new Map();
        const entry = clientEntry(root());
        program = ts.createProgram([entry], readPluginCompilerOptions(root(), dirname(entry), true));
        checker = program.getTypeChecker();
        for (const file of program.getSourceFiles()) {
          for (const statement of file.statements) {
            if (
              !ts.isImportDeclaration(statement) ||
              !ts.isStringLiteral(statement.moduleSpecifier) ||
              statement.moduleSpecifier.text !== "@tokamak/sdk/client"
            )
              continue;
            const sdk = checker.getSymbolAtLocation(statement.moduleSpecifier);
            const helper = sdk && checker.getExportsOfModule(sdk).find((s) => s.name === "defineSlot");
            if (helper)
              slotHelpers.add(
                helper.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(helper) : helper,
              );
          }
        }
        const source = program.getSourceFile(entry)!;
        const module = checker.getSymbolAtLocation(source)!;
        for (let symbol of checker.getExportsOfModule(module)) {
          const name = symbol.name;
          if (!/^[A-Z]/.test(name)) continue;
          if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
          const declaration = symbol.valueDeclaration;
          if (
            !declaration ||
            !checker.getTypeOfSymbolAtLocation(symbol, declaration).getCallSignatures().length
          )
            continue;
          const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
          if (type.getProperties().some((p) => p.name.startsWith("__@contributionBrand@"))) continue;
          const file = normalizePath(declaration.getSourceFile().fileName);
          if (!file.startsWith(normalizePath(root()) + "/src/")) continue;
          let names = declarations.get(file);
          if (!names) declarations.set(file, (names = new Map()));
          const targets = names.get(symbol.name) ?? [];
          targets.push(`${pluginId()}.${name}`);
          names.set(symbol.name, targets);
        }
      }
      const source =
        program.getSourceFile(id) ??
        ts.createSourceFile(
          id,
          code,
          ts.ScriptTarget.Latest,
          true,
          id.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
      const output = new MagicString(code);
      let changed = false;
      let imports = false;
      for (const node of source.statements) {
        if (ts.isFunctionDeclaration(node) && node.name) {
          const target = declarations.get(id)?.get(node.name.text);
          if (target) {
            const name = node.name.text;
            let exported = "";
            for (const modifier of node.modifiers ?? [])
              if (
                modifier.kind === ts.SyntaxKind.ExportKeyword ||
                modifier.kind === ts.SyntaxKind.DefaultKeyword
              ) {
                exported += `${modifier.getText(source)} `;
                output.remove(modifier.getStart(source), modifier.end);
              }
            output.overwrite(node.name.getStart(source), node.name.end, `${name}Original`);
            // The public name stays a function declaration so it is hoisted like the
            // original; the wrapped component is made on first use.
            output.appendLeft(
              node.end,
              `\n${exported}function ${name}(props) { return (${name}.__public ??= __publicComponent(${JSON.stringify(target)}, ${name}Original))(props); }\n`,
            );
            changed = imports = true;
          }
        } else if (ts.isVariableStatement(node)) {
          for (const declaration of node.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
            const target = declarations.get(id)?.get(declaration.name.text);
            if (target) {
              const init = declaration.initializer;
              output.appendLeft(init.getStart(source), `__publicComponent(${JSON.stringify(target)}, `);
              output.appendLeft(init.end, ")");
              changed = imports = true;
            }
          }
        }
      }
      function isSlotHelper(expression: ts.Expression) {
        let symbol = checker.getSymbolAtLocation(
          ts.isPropertyAccessExpression(expression) ? expression.name : expression,
        );
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        return !!symbol && slotHelpers.has(symbol);
      }
      function slots(node: ts.Node) {
        if (ts.isCallExpression(node) && isSlotHelper(node.expression)) {
          const name = node.arguments[0];
          if (!name || !ts.isStringLiteralLike(name)) throw new Error("defineSlot requires a literal name");
          output.overwrite(name.getStart(source), name.end, JSON.stringify(`${pluginId()}.${name.text}`));
          changed = true;
        }
        ts.forEachChild(node, slots);
      }
      slots(source);
      if (imports)
        output.prepend('import { publicComponent as __publicComponent } from "@tokamak/sdk/client";\n');
      if (changed)
        return {
          code: output.toString(),
          map: output.generateMap({ source: id, includeContent: true, hires: true }),
        };
    },
  };
}
