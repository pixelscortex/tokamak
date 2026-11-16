import ts from "typescript";
import MagicString from "magic-string";
import type { Plugin } from "vite";

export function pluginImports(options: { ui?: false; standalone?: boolean }): Plugin["transform"] {
  return {
    order: "post",
    handler(code, id) {
      if (options.ui === false || options.standalone || !/\.[cm]?[jt]sx?(?:\?|$)/.test(id)) return;
      const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const edits: { start: number; end: number; text: string }[] = [];
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = node.arguments[0];
          if (!arg || !ts.isStringLiteralLike(arg)) throw new Error(`Dynamic plugin imports require a string literal: ${id}. Use import("@plugins/<id>/ui").`);
          const match = /^@plugins\/([^/]+)(?:\/ui)?$/.exec(arg.text);
          if (match) edits.push({ start: node.getStart(source), end: node.end,
            text: `__tokamakModules.load(${JSON.stringify(`@plugins/${match[1]}/ui`)})` });
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      if (!edits.length) return;
      const output = new MagicString(code);
      for (const edit of edits) output.overwrite(edit.start, edit.end, edit.text);
      return { code: output.toString(), map: output.generateMap({ source: id, includeContent: true, hires: true }) };
    },
  };
}
