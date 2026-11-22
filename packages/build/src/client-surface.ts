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
): Plugin {
  let directory: string;
  let program: ts.Program;
  let parts: ReturnType<typeof componentParts>;
  let windowState: ReturnType<typeof windowStateTransform>;
  return {
    name: "tokamak-client-surface",
    enforce: "pre",
    generateBundle: {
      order: "post",
      handler() {
        parts?.publish((message) => this.warn(message));
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
            ...parsed.options,
          }),
        );
        // Both transforms share source coordinates. Window state only sees
        // code retained in the window, so it cannot edit an erased handler.
        windowState = windowStateTransform(directory, entry, program, (file) =>
          erasedNodes(file, placement(normalizePath(file.fileName))),
        );
        parts = componentParts(
          program.getSourceFile(entry)!,
          program.getTypeChecker(),
          pluginId(),
          directory,
        );
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
      if (parts.transform(source, output, state?.partMounts) || state || cuts.length)
        return {
          code: output.toString(),
          map: output.generateMap({ source: id, includeContent: cuts.length === 0, hires: true }),
        };
    },
  };
}
