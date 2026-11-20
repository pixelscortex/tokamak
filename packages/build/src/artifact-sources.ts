import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packages = fileURLToPath(new URL("../../", import.meta.url));
const portable = (path: string) => path.split(sep).join("/");
const syntheticEntry = /^(?:tokamak-feature|worker):entry$/;
const inside = (path: string) => path !== ".." && !path.startsWith("../") && !isAbsolute(path);

export function artifactSourcePath(root: string, base: string, source: string): string {
  if (!source || syntheticEntry.test(source)) return source;
  const path = source.startsWith("file:") ? fileURLToPath(source) : resolve(base, source);
  const installed = portable(path);
  const dependency = installed.lastIndexOf("/node_modules/");
  if (dependency !== -1) return installed.slice(dependency + 1);
  const local = portable(relative(root, path));
  if (inside(local)) return local;
  const workspace = portable(relative(packages, path));
  if (inside(workspace)) return `node_modules/@tokamak/${workspace}`;
  return `external/${basename(path)}`;
}

export function artifactSourceMap(root: string, file: string, text: string) {
  const map = JSON.parse(text) as {
    file?: string;
    sourceRoot?: string;
    sources: string[];
    sourcesContent?: (string | null)[];
    debugId?: string;
  };
  // Bun's debug ID includes its original path comments and source map paths.
  delete map.debugId;
  const base = resolve(dirname(file), map.sourceRoot ?? "");
  delete map.sourceRoot;
  if (map.file) map.file = basename(map.file);
  map.sources = map.sources.map((source, index) => {
    const content = map.sourcesContent?.[index];
    if (syntheticEntry.test(source) && content && map.sourcesContent) {
      // The synthetic entry imports absolute files so the compiler can resolve them.
      map.sourcesContent[index] = content.replace(/\bfrom ("(?:[^"\\]|\\.)*")/g, (statement, specifier) => {
        const path = JSON.parse(specifier) as string;
        return isAbsolute(path) ? `from ${JSON.stringify(artifactSourcePath(root, base, path))}` : statement;
      });
    }
    return artifactSourcePath(root, base, source);
  });
  return map;
}

export function withoutBunPathComments(code: string) {
  const file = ts.createSourceFile("bundle.js", code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const edits: { pos: number; end: number }[] = [];
  for (const node of [...file.statements, file.endOfFileToken]) {
    for (const { pos, end } of ts.getLeadingCommentRanges(code, node.pos) ?? []) {
      const comment = code.slice(pos, end);
      if (/^\/\/ (?:\.{1,2}[/\\]|\/|[a-z]:[/\\]|file:)/i.test(comment) || comment.startsWith("//# debugId="))
        edits.push({ pos, end });
    }
  }
  // Leave the line breaks in place so the generated source map remains valid.
  for (const { pos, end } of edits.reverse()) code = code.slice(0, pos) + code.slice(end);
  return code;
}
