import { createRequire } from "node:module";

const filename = "tokamak-doctor.ts";
const source = "export const check: number = 1;";

async function typescript() {
  const { default: ts } = await import("typescript");
  const options = { noLib: true, noEmit: true };
  const host = {
    getSourceFile: (name: string, target: import("typescript").ScriptTarget) =>
      name === filename ? ts.createSourceFile(name, source, target) : undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name: string) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name: string) => name === filename,
    readFile: (name: string) => (name === filename ? source : undefined),
  };
  const program = ts.createProgram([filename], options, host);
  const error = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()][0];
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, " "));
}

async function solid() {
  // Resolve the native compiler used by the Solid Vite plugin.
  const require = createRequire(import.meta.url);
  const compilerPath = createRequire(require.resolve("@solidjs/vite-plugin")).resolve("@solidjs/compiler");
  const compiler = (await import(compilerPath)) as {
    transformAsync(source: string, options: object): Promise<{ code: string }>;
  };
  const { code } = await compiler.transformAsync("export const Check = () => <div>ok</div>;", {
    filename: "tokamak-doctor.tsx",
    generate: "dom",
    moduleName: "@solidjs/web",
  });
  if (!code.includes("@solidjs/web")) throw new Error("Component did not compile to Solid DOM code");
}

async function tailwind() {
  const { compile } = await import("@tailwindcss/node");
  const compiler = await compile("@tailwind utilities;", { base: process.cwd(), onDependency() {} });
  if (!compiler.build(["underline"]).includes("text-decoration-line: underline")) {
    throw new Error("The underline utility did not compile");
  }
}

export async function checkBuildTools() {
  for (const [name, check] of [
    ["TypeScript", typescript],
    ["Solid compiler", solid],
    ["Tailwind", tailwind],
  ] as const) {
    try {
      await check();
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
