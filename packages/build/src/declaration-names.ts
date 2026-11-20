import ts from "typescript";

function straightReturn(node: ts.FunctionLikeDeclaration) {
  const body = node.body;
  if (!body || !ts.isBlock(body)) return body;
  const first = body.statements[0];
  return body.statements.length === 1 && first && ts.isReturnStatement(first) ? first.expression : undefined;
}

/** Keep an existing parameter's public spelling when a function returns that
 * parameter unchanged. Otherwise the emitter can expand an alias into internals. */
export function preserveReturnNames(program: ts.Program, entries: string[], root: string) {
  const replacements = new Map<string, string>();
  const host = ts.createCompilerHost(program.getCompilerOptions());
  for (const source of program.getSourceFiles()) {
    if (
      source.isDeclarationFile ||
      !source.fileName.startsWith(root) ||
      program.isSourceFileFromExternalLibrary(source)
    )
      continue;
    const edits: [number, string][] = [];
    function visit(node: ts.Node) {
      if (
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) &&
        !node.type &&
        !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) &&
        (!("asteriskToken" in node) || !node.asteriskToken)
      ) {
        const returned = straightReturn(node);
        if (returned && ts.isIdentifier(returned)) {
          const parameter = node.parameters.find(
            (p) => ts.isIdentifier(p.name) && p.name.text === returned.text && p.type && !p.questionToken,
          );
          if (parameter?.type) {
            const token = node
              .getChildren(source)
              .find(
                (part) =>
                  part.kind ===
                  (ts.isArrowFunction(node)
                    ? ts.SyntaxKind.EqualsGreaterThanToken
                    : ts.SyntaxKind.CloseParenToken),
              );
            if (token)
              edits.push([
                ts.isArrowFunction(node) ? token.getStart(source) : token.end,
                `: ${parameter.type.getText(source)} `,
              ]);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (!edits.length) continue;
    let text = source.text;
    for (const [position, annotation] of edits.sort((a, b) => b[0] - a[0]))
      text = text.slice(0, position) + annotation + text.slice(position);
    replacements.set(source.fileName, text);
  }
  if (!replacements.size) return program;
  const load = host.getSourceFile.bind(host);
  host.getSourceFile = (file, ...args) => {
    const source = replacements.get(file);
    return source === undefined ? load(file, ...args) : ts.createSourceFile(file, source, args[0], true);
  };
  return ts.createProgram(entries, program.getCompilerOptions(), host);
}
