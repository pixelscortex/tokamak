import type { Command } from "../command";
import { updateIndex } from "../plugin-index";

export default {
  path: "plugin remove",
  summary: "Remove a plugin from the local plugin index.",
  args: { name: "id" },
  example: "tokamak plugin remove my-plugin",
  async run([id]) {
    await updateIndex((entries) => {
      if (!entries.delete(id!)) throw new Error(`Unknown indexed plugin: ${id}`);
      return true;
    });
    return {
      data: { id, restartRequired: true },
      text: `Removed ${id} from the index. The local server picks this up at its next start.`,
    };
  },
} satisfies Command;
