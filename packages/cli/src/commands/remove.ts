import type { Command } from "../command";
import { readIndex, writeIndex } from "../plugin-index";

export default {
  path: "plugin remove",
  summary: "Remove a plugin from the local plugin index.",
  args: { name: "id" },
  example: "tokamak plugin remove my-plugin",
  async run([id]) {
    const entries = await readIndex();
    if (!entries.delete(id!)) throw new Error(`Unknown indexed plugin: ${id}`);
    await writeIndex(entries);
    return {
      data: { id, restartRequired: true },
      text: `Removed ${id} from the index. The local server picks this up at its next start.`,
    };
  },
} satisfies Command;
