import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CommandError, type Command } from "../command";
import { runBuilder, withBuildLock } from "../plugin-build";

export default {
  path: "plugin build",
  summary: "Build a plugin once.",
  args: { name: "folder", optional: true },
  example: "tokamak plugin build . --json",
  async run([folder]) {
    return withBuildLock(folder, buildInFolder);
  },
} satisfies Command;

export async function buildInFolder(folder: string) {
  const { outputFolder, warnings } = await runBuilder(folder, "--result-json");
  if (!outputFolder) throw new Error("The build did not report its output folder");
  const id = await readFile(resolve(outputFolder, "manifest.json"), "utf8")
    .then((source) => {
      const id: unknown = JSON.parse(source)?.plugin?.id;
      if (typeof id !== "string" || !id) throw new Error("The build manifest has no plugin id");
      return id;
    })
    .catch((error: Error) => {
      throw new CommandError("Plugin build failed", "tokamak plugin build --help", [
        { message: `Could not read the build manifest: ${error.message}` },
      ]);
    });
  return { data: { id, outputFolder }, text: `Built ${id}: ${outputFolder}`, warnings };
}
