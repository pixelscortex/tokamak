import { access, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { CommandError, type Command } from "../command";
import { runBuilder } from "../plugin-build";
import { updateIndex } from "../plugin-index";

export default {
  path: "plugin add",
  summary: "Add a source folder to the local plugin index.",
  args: { name: "folder" },
  example: "tokamak plugin add ./my-plugin",
  async run([source]) {
    const folder = await realpath(source!);
    if (!(await stat(folder)).isDirectory()) throw new Error(`Not a source folder: ${folder}`);
    const hasConfig = await access(join(folder, "vite.config.ts")).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (hasConfig) await runBuilder(folder, "--check-index");
    const { readSourcePlugin } = await import("../../../build/src/descriptor");
    const { id } = await readSourcePlugin(folder);
    await updateIndex((entries) => {
      const existing = entries.get(id);
      if (existing !== undefined && existing !== folder)
        throw new CommandError(
          `Plugin ${id} is already indexed at ${existing}`,
          `tokamak plugin remove ${id}`,
        );
      if (existing) return false;
      entries.set(id, folder);
      return true;
    });
    return {
      data: { id, folder, restartRequired: true, precedence: "index" },
      text: `Indexed ${id} at ${folder}. The local server picks this up at its next start. The indexed build takes precedence over any ${id} from --plugins.`,
    };
  },
} satisfies Command;
