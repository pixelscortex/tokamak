/** Public client declarations come from the entry's symbol graph, never a
 * runtime scan. This also intercepts calls inside the declaring plugin. */
import ts from "typescript";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { resolve } from "node:path";

export function clientSurface(root: () => string, pluginId: () => string): Plugin {
  let declarations: Map<string, Map<string, string>>;
  return {
    name: "tokamak-client-surface",
    enforce: "pre",
    transform(code, id) {
      if (!id.startsWith(root() + "/src/") || !/\.tsx?$/.test(id)) return;
      if (!declarations) {
        declarations = new Map();
        const entry = resolve(root(), "src/main.tsx");
        const configPath = ts.findConfigFile(root(), ts.sys.fileExists);
        const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile).config : {};
        const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root());
        const program = ts.createProgram([entry], parsed.options);
        const checker = program.getTypeChecker();
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
          const file = declaration.getSourceFile().fileName;
          if (!file.startsWith(root() + "/src/")) continue;
          let names = declarations.get(file);
          if (!names) declarations.set(file, (names = new Map()));
          names.set(symbol.name, `${pluginId()}.${name}`);
        }
      }
      const source = ts.createSourceFile(
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
            for (const modifier of node.modifiers ?? [])
              if (modifier.kind === ts.SyntaxKind.ExportKeyword)
                output.remove(modifier.getStart(source), modifier.end);
            output.overwrite(node.name.getStart(source), node.name.end, `${name}Original`);
            // Preserve the callable signature (including props inference).
            output.appendLeft(
              node.end,
              `\nexport const ${name} = __publicComponent(${JSON.stringify(target)}, ${name}Original);\n`,
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
      function slots(node: ts.Node) {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "defineSlot"
        ) {
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
