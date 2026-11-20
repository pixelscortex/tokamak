import type { Command } from "../command";
import { serverGet } from "../server";

type LoadedPlugin = { plugin: { id: string; version: string }; fromIndex?: boolean };

export default {
  path: "plugin list",
  summary: "List plugins loaded by the running server.",
  example: "tokamak plugin list --json",
  async run(_, { server }) {
    const catalog = (await serverGet("/plugins", server)) as { plugins: LoadedPlugin[] };
    const plugins = catalog.plugins.map(({ plugin: { id, version }, fromIndex }) => ({
      id,
      version,
      fromIndex: fromIndex === true,
    }));
    return {
      data: { plugins },
      text: plugins.length
        ? plugins
            .map(({ id, version, fromIndex }) => `${id}\t${version}${fromIndex ? "\tindex" : ""}`)
            .join("\n")
        : "No plugins loaded.",
    };
  },
} satisfies Command;
