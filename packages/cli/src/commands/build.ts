import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CommandError, type Command } from "../command";

const builder = fileURLToPath(new URL("../../../build/src/build.ts", import.meta.url));

function diagnostics(message: string) {
  const plain = /^(.*)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm;
  const tagged = /<error file="([^"]+)" line="(\d+)" column="(\d+)" code="(TS\d+)">\s*([^<]*)/g;
  return [...message.matchAll(plain), ...message.matchAll(tagged)].map(
    ([, file, line, column, code, text]) => ({
      file,
      line: Number(line),
      column: Number(column),
      code,
      message: text?.trim(),
    }),
  );
}

export default {
  path: "plugin build",
  summary: "Build a plugin once.",
  args: { name: "folder", optional: true },
  example: "tokamak plugin build . --json",
  async run([folder]) {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [builder, "--result-json", resolve(folder ?? ".")],
      { maxBuffer: 16 * 1024 * 1024 },
    ).catch((error: { stdout?: string; stderr?: string; message: string }) => {
      const message = [error.stdout, error.stderr].filter(Boolean).join("\n").trim() || error.message;
      const details = diagnostics(message);
      throw new CommandError(
        `Plugin build failed: ${message}`,
        "tokamak plugin build --help",
        details.length ? details : undefined,
      );
    });
    const result = stdout
      .split("\n")
      .reverse()
      .find((line) => line.startsWith("Tokamak build result: "));
    if (!result) throw new Error("The build did not report its output folder");
    const { outputFolder } = JSON.parse(result.slice("Tokamak build result: ".length));
    const {
      plugin: { id },
    } = JSON.parse(await readFile(resolve(outputFolder, "manifest.json"), "utf8"));
    return { data: { id, outputFolder }, text: `Built ${id}: ${outputFolder}` };
  },
} satisfies Command;
