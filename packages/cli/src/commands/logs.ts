import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError, type Command } from "../command";
import { readIndex } from "../plugin-index";
import { serverGet } from "../server";

type Entry = { time: number; source: string; level: string; text: string };

export default {
  path: "plugin logs",
  summary: "Read a plugin log on this machine.",
  args: { name: "id" },
  flags: { errors: { summary: "Show only errors." } },
  example: "tokamak plugin logs my-plugin --errors --json",
  async run([id], { flags, server }) {
    const unknown = () => new CommandError(`Unknown plugin: ${id}`, "tokamak plugin list");
    if (!id || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(id)) throw unknown();
    if (!(await readIndex()).has(id)) {
      const catalog = (await serverGet("/plugins", server).catch(() => null)) as {
        plugins: { plugin: { id: string } }[];
      } | null;
      if (!catalog?.plugins.some((entry) => entry.plugin.id === id)) throw unknown();
    }
    const folder = process.env.TOKAMAK_PLUGIN_LOG_DIR || join(tmpdir(), "tokamak", "logs");
    const source = await readFile(join(folder, `${id}.log`), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const entries = source
      .split("\n")
      .slice(0, -1)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Entry)
      .filter((entry) => flags.errors !== true || entry.level === "error");
    return {
      data: { entries },
      text: entries
        .map(
          (entry) => `${new Date(entry.time).toISOString()} [${entry.source}/${entry.level}] ${entry.text}`,
        )
        .join("\n"),
    };
  },
} satisfies Command;
