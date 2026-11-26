import { inSource } from "./compiler.ts";
import { realpathSync } from "node:fs";
import { pluginCompilerOptions } from "../../sdk/tools/plugin-compiler.mjs";
import { componentParts } from "./component-parts.ts";
import { clientEntry } from "./descriptor.ts";
/** Public client declarations come from the entry's symbol graph, never a
 * runtime scan. This also intercepts calls inside the declaring plugin. */
import ts from "typescript";
import { normalizePath } from "vite";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { windowStateTransform } from "./window-state.ts";

type SourceEdit = [start: number, end: number, replacement: string];

function erasedNodes(source: ts.SourceFile, cuts: SourceEdit[]) {
  return (node: ts.Node) => cuts.some(([start, end]) => node.getStart(source) >= start && node.end <= end);
}

export function clientSurface(
  root: () => string,
  pluginId: () => string,
  placement: (id: string) => SourceEdit[] = () => [],
  catalog?: string,
): Plugin[] {
  let directory: string;
  let program: ts.Program;
  let parts: ReturnType<typeof componentParts>;
  let windowState: ReturnType<typeof windowStateTransform>;
  const surface: Plugin = {
    name: "tokamak-client-surface",
    enforce: "pre",
    generateBundle: {
      order: "post",
      handler() {
        parts?.publish((message) => this.warn(message), catalog);
      },
    },
    transform(code, id) {
      id = normalizePath(id);
      // Vite uses real paths for module IDs, even when the plugin root is a symlink.
      directory ??= normalizePath(realpathSync(root()));
      if (!inSource(directory, id) || !/\.tsx?$/.test(id)) return;
      if (!program) {
        const entry = clientEntry(directory);
        const configPath = ts.findConfigFile(directory, ts.sys.fileExists);
        const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile).config : {};
        const parsed = ts.parseJsonConfigFileContent(config, ts.sys, directory);
        program = ts.createProgram(
          [entry],
          pluginCompilerOptions(directory, {
            // Resolve package exports and read TSX even when the plugin has no tsconfig.
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            jsx: ts.JsxEmit.Preserve,
            jsxImportSource: "@solidjs/web",
            ...parsed.options,
          }),
        );
        // Both transforms share source coordinates. Window state only sees
        // code retained in the window, so it cannot edit an erased handler.
        windowState = windowStateTransform(directory, entry, program, (file) =>
          erasedNodes(file, placement(normalizePath(file.fileName))),
        );
        parts = componentParts(program.getSourceFile(entry)!, program, pluginId(), directory);
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
      const cuts = placement(id);
      for (const [start, end, replacement] of cuts) output.overwrite(start, end, replacement);
      // Both transforms use the original offsets. A part mounts its original
      // tag lazily, so attach the state site to that tag inside its render callback.
      const state = windowState(source, output, parts.has);
      if (
        parts.transform(source, output, state?.partMounts, erasedNodes(source, cuts)) ||
        state ||
        cuts.length
      )
        return {
          code: output.toString(),
          map: output.generateMap({ source: id, includeContent: cuts.length === 0, hires: true }),
        };
    },
  };
  return [surface, compiledParts()];
}

function compiledParts(): Plugin {
  return {
    name: "tokamak-compiled-parts",
    enforce: "post",
    transform(code, id) {
      if (!code.includes("__tokamakScalarText(") && !code.includes("__tokamakComponent(")) return;
      // Solid already located the parent in the cloned template. Change the
      // generated scalar insert so its effect owns a movable Text node.
      const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const inserts = new Set<string>();
      const components = new Set<string>();
      for (const statement of source.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          statement.moduleSpecifier.getText(source).slice(1, -1) !== "@solidjs/web"
        )
          continue;
        const imports = statement.importClause?.namedBindings;
        if (imports && ts.isNamedImports(imports))
          for (const binding of imports.elements)
            switch ((binding.propertyName ?? binding.name).text) {
              case "insert":
                inserts.add(binding.name.text);
                break;
              case "createComponent":
                components.add(binding.name.text);
                break;
            }
      }
      const output = new MagicString(code);
      let uncompiled = false;
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const name = node.expression.text;
          if (name === "__tokamakScalarText") uncompiled = true;
          if (name === "__tokamakComponent") {
            const [call] = node.arguments;
            if (
              !call ||
              !ts.isCallExpression(call) ||
              !ts.isIdentifier(call.expression) ||
              !components.has(call.expression.text)
            )
              throw new Error(`Solid did not compile a component part in ${id}`);
            output.overwrite(node.getStart(source), call.expression.end, "__tokamakContents.c");
            output.remove(call.end, node.end);
            ts.forEachChild(call, visit);
            return;
          }
          const body = inserts.has(name) && scalarTextBinding(node.arguments[1]);
          if (body) {
            const value = body.arguments[0]!;
            output.overwrite(node.expression.getStart(source), node.expression.end, "__tokamakText");
            output.overwrite(body.getStart(source), value.getStart(source), "(");
            output.overwrite(value.end, body.end, ")");
            visit(value);
            return;
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      if (uncompiled) throw new Error(`Solid did not compile a native text binding in ${id}`);
      if (!output.hasChanged()) return;
      if (code.includes("__tokamakScalarText("))
        output.prepend('import { __renderNativeText as __tokamakText } from "@tokamak/sdk/client";\n');
      return { code: output.toString(), map: output.generateMap({ source: id, hires: true }) };
    },
  };
}

function scalarTextBinding(read: ts.Expression | undefined) {
  if (!read || !ts.isArrowFunction(read)) return;
  const first = ts.isBlock(read.body) && read.body.statements.length === 1 && read.body.statements[0];
  let body = ts.isBlock(read.body) ? first && ts.isReturnStatement(first) && first.expression : read.body;
  while (body && ts.isParenthesizedExpression(body)) body = body.expression;
  if (
    body &&
    ts.isCallExpression(body) &&
    ts.isIdentifier(body.expression) &&
    body.expression.text === "__tokamakScalarText"
  )
    return body;
}
