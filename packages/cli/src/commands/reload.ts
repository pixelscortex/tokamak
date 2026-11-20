import { resolve } from "node:path";
import { CommandError, type Command } from "../command";
import { readIndex } from "../plugin-index";
import { ServerRefusal, serverPost } from "../server";
import build from "./build";

type PluginResult =
  | { id: string; status: "loaded" }
  | {
      id: string;
      status: "build-failed" | "load-failed";
      error: { message: string; diagnostics?: object[] };
    };

function failure(id: string, status: "build-failed" | "load-failed", cause: unknown): PluginResult {
  const message = cause instanceof Error ? cause.message : String(cause);
  const diagnostics = cause instanceof CommandError ? cause.diagnostics : undefined;
  return { id, status, error: { message, ...(diagnostics ? { diagnostics } : {}) } };
}

async function applyBuilds(
  ids: string[],
  removeMissing: boolean,
  results: Map<string, PluginResult>,
  server?: string,
) {
  if (!ids.length && !removeMissing) return {};
  const reload = (selected: string[], remove: boolean) =>
    serverPost("/plugin-index/reload", { ids: selected, removeMissing: remove }, server);
  const loaded = (id: string) => results.set(id, { id, status: "loaded" });
  try {
    await reload(ids, removeMissing);
    ids.forEach(loaded);
    return {};
  } catch (error) {
    const next = error instanceof CommandError ? error.next : undefined;
    if (!(error instanceof ServerRefusal) || !removeMissing || !ids.length) {
      for (const id of ids) results.set(id, failure(id, "load-failed", error));
      return { next, removalsError: removeMissing ? error : undefined };
    }
    // Try a batch first so related versions can change together. If it is
    // refused, isolate the builds so unrelated plugins can still load.
    for (const id of ids) {
      try {
        await reload([id], false);
        loaded(id);
      } catch (error) {
        results.set(id, failure(id, "load-failed", error));
      }
    }
    try {
      await reload([], true);
      return { next };
    } catch (removalsError) {
      return { next, removalsError };
    }
  }
}

export default {
  path: "plugin reload",
  summary: "Build and reload indexed plugins in the running local server.",
  args: { name: "id", optional: true },
  example: "tokamak plugin reload my-plugin --json",
  async run([id], { server }) {
    const index = await readIndex();
    const selected = id === undefined ? [...index.keys()] : [id];
    const results = new Map<string, PluginResult>();
    const built: string[] = [];
    for (const plugin of selected) {
      const folder = index.get(plugin);
      if (folder === undefined)
        throw new CommandError(`Unknown indexed plugin: ${plugin}`, "tokamak plugin add");
      try {
        const { data } = await build.run([folder]);
        if (data.id !== plugin) throw new Error(`Build produced plugin ${data.id}, expected ${plugin}`);
        if (data.outputFolder !== resolve(folder, "dist"))
          throw new Error(`Indexed plugins must build into ${resolve(folder, "dist")}`);
        built.push(plugin);
      } catch (error) {
        results.set(plugin, failure(plugin, "build-failed", error));
      }
    }

    const { next = "tokamak plugin reload --help", removalsError } = await applyBuilds(
      built,
      id === undefined,
      results,
      server,
    );
    const plugins = selected.map((plugin) => results.get(plugin)!);
    const lines = plugins.map((plugin) =>
      plugin.status === "loaded" ? `Loaded ${plugin.id}` : `${plugin.id}: ${plugin.error.message}`,
    );
    if (removalsError) lines.push(`Could not apply index removals: ${String(removalsError)}`);
    if (plugins.some((plugin) => plugin.status !== "loaded") || removalsError) {
      throw new CommandError(lines.join("\n"), next, undefined, { plugins });
    }
    return {
      data: { plugins },
      text: lines.join("\n") || "Applied index removals. No indexed plugins to build.",
    };
  },
} satisfies Command;
