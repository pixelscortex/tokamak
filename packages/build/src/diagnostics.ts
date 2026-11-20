import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

export interface BuildDiagnostic {
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
}

export class BuildError extends Error {
  constructor(
    readonly diagnostics: BuildDiagnostic[],
    options?: ErrorOptions,
  ) {
    super(
      diagnostics
        .map(
          ({ file, line, column, code, message }) =>
            `${file ? `${file}(${line},${column}): ` : ""}${code ? `error ${code}: ` : ""}${message}`,
        )
        .join("\n"),
      options,
    );
  }
}

export const sdkDiagnosticPrefix = "Tokamak SDK diagnostics: ";

export function sourceLocation(file: string, text: string, offset: number) {
  const lines = text.slice(0, offset).split(/\r\n|\n|\r/);
  return { file: resolve(file), line: lines.length, column: lines.at(-1)!.length + 1 };
}

export function locateImportError(error: unknown, importer: string, specifier: string) {
  if (!(error instanceof BuildError)) return error;
  const file = importer.split("?")[0]!;
  let loc = { file: resolve(file), line: 1, column: 1 };
  try {
    const text = readFileSync(file, "utf8");
    const imported = ts
      .preProcessFile(text, true, true)
      .importedFiles.find(({ fileName }) => fileName === specifier);
    if (imported) loc = sourceLocation(file, text, imported.pos);
  } catch {
    // A virtual or generated importer may not exist on disk.
  }
  return new BuildError(error.diagnostics.map((diagnostic) => ({ ...loc, ...diagnostic })));
}

export function typescriptDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
  root: string,
): BuildDiagnostic[] {
  function message(text: string | ts.DiagnosticMessageChain, indent = ""): string {
    return typeof text === "string"
      ? text
      : [
          text.messageText,
          ...(text.next ?? []).map((child) => indent + "  " + message(child, indent + "  ")),
        ].join("\n");
  }
  return diagnostics.map((diagnostic) => {
    const result = { code: `TS${diagnostic.code}`, message: message(diagnostic.messageText) };
    if (!diagnostic.file || diagnostic.start === undefined) return result;
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return {
      ...result,
      file: resolve(root, diagnostic.file.fileName),
      line: line + 1,
      column: character + 1,
    };
  });
}

const xmlEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (value: string) =>
  value.replace(/&(amp|lt|gt|quot|apos);/g, (_, key) => xmlEntities[key]!);

export function checkerDiagnostics(output: string, cwd: string): BuildDiagnostic[] {
  const record = output
    .split("\n")
    .reverse()
    .find((line) => line.startsWith(sdkDiagnosticPrefix));
  if (record) {
    const diagnostics: unknown = JSON.parse(record.slice(sdkDiagnosticPrefix.length));
    if (Array.isArray(diagnostics)) return diagnostics;
  }
  const tagged = /<error\b([^>]*)>([\s\S]*?)<\/error>/g;
  const blocks = [...output.matchAll(tagged)];
  if (blocks.length) {
    return blocks.map(([, attributes, text]) => {
      const fields = Object.fromEntries(
        [...attributes!.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, unescapeXml(value!)]),
      );
      return {
        ...location(cwd, fields.file, Number(fields.line), Number(fields.column)),
        code: fields.code,
        message: unescapeXml(text!.split(/^<source>\r?$/m, 1)[0]!.trim()),
      };
    });
  }
  const plain = /^(?:(.+)\((\d+),(\d+)\): )?error (TS\d+): (.*(?:\n[ \t]+[^\n]+)*)$/gm;
  return [...output.matchAll(plain)].map(([, file, line, column, code, message]) => ({
    ...location(cwd, file, Number(line), Number(column)),
    code,
    message: message!.trimEnd(),
  }));
}

function location(root: string, file?: string, line?: number, column?: number) {
  return file && line && Number.isInteger(line)
    ? { file: resolve(root, file), line, ...(column && Number.isInteger(column) ? { column } : {}) }
    : {};
}

export function buildDiagnostics(error: unknown, root: string): BuildDiagnostic[] {
  if (!(error instanceof Error)) return [{ message: String(error) }];
  const detail = error as Error & {
    diagnostics?: BuildDiagnostic[];
    errors?: unknown[];
    loc?: { file?: string; line?: number; column?: number };
    id?: string;
    code?: string;
  };
  if (detail.diagnostics?.length) return detail.diagnostics;
  if (Array.isArray(detail.errors) && detail.errors.length)
    return detail.errors.flatMap((child) => buildDiagnostics(child, root));
  if (detail.cause) return buildDiagnostics(detail.cause, root);
  return [
    {
      ...location(root, detail.loc?.file ?? detail.id, detail.loc?.line, detail.loc?.column),
      ...(typeof detail.code === "string" ? { code: detail.code } : {}),
      message: detail.message,
    },
  ];
}
