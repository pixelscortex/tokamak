import type { Command } from "../command";
import { serverGet } from "../server";

type LoadedPlugin = { plugin: { id: string; version: string }; fromIndex?: boolean; revision: string };

export default {
  path: "plugin list",
  usesServer: true,
  summary: "List plugins loaded by the running server.",
  example: "tokamak plugin list --json",
  async run(_, { server }) {
    const catalog = (await serverGet("/plugins", server)) as { plugins: LoadedPlugin[] };
    if (server) {
      const plugins = catalog.plugins.map(({ plugin: { id, version }, revision }) => ({
        id,
        version,
        buildId: revision,
        status: "loaded",
      }));
      return {
        data: { plugins },
        text:
          plugins
            .map(({ id, version, buildId, status }) => `${id}\t${version}\t${buildId}\t${status}`)
            .join("\n") || "No plugins loaded.",
      };
    }
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
