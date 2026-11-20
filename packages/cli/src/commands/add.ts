import { realpath, stat } from "node:fs/promises";
import { readSourcePlugin } from "../../../build/src/descriptor";
import { CommandError, type Command } from "../command";
import { readIndex, writeIndex } from "../plugin-index";

export default {
  path: "plugin add",
  summary: "Add a source folder to the local plugin index.",
  args: { name: "folder" },
  example: "tokamak plugin add ./my-plugin",
  async run([source]) {
    const folder = await realpath(source!);
    if (!(await stat(folder)).isDirectory()) throw new Error(`Not a source folder: ${folder}`);
    const { id } = await readSourcePlugin(folder);
    const entries = await readIndex();
    const existing = entries.get(id);
    if (existing !== undefined && existing !== folder)
      throw new CommandError(`Plugin ${id} is already indexed at ${existing}`, `tokamak plugin remove ${id}`);
    if (!existing) {
      entries.set(id, folder);
      await writeIndex(entries);
    }
    return {
      data: { id, folder, reloadRequired: true },
      text: `Indexed ${id} at ${folder}. Run tokamak plugin reload ${id} to apply it now.`,
    };
  },
} satisfies Command;
