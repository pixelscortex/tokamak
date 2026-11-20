import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError, type Command, type StreamOutput } from "../command";
import { dataFolder } from "../data";
import { readIndex } from "../plugin-index";
import { serverGet } from "../server";

type Entry = { time: number; source: string; level: string; text: string; kind?: string };
const MAX_RECORD = 192 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function parse(line: Buffer | undefined): Entry | undefined {
  if (!line?.length) return undefined;
  try {
    const entry = JSON.parse(decoder.decode(line)) as Entry | null;
    if (
      entry &&
      Number.isFinite(entry.time) &&
      Math.abs(entry.time) <= 8.64e15 &&
      (entry.source === "server" || entry.source === "window") &&
      ["log", "debug", "info", "warn", "error"].includes(entry.level) &&
      typeof entry.text === "string" &&
      (entry.kind === undefined || typeof entry.kind === "string")
    )
      return entry;
  } catch {
    // Keep scanning after a malformed record.
  }
}

async function* records(file: Awaited<ReturnType<typeof open>>) {
  let pending: Buffer | undefined = Buffer.alloc(0);
  for await (const chunk of file.createReadStream()) {
    const bytes = chunk as Buffer;
    let start = 0;
    for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
      if (pending && pending.length + end - start <= MAX_RECORD)
        yield parse(Buffer.concat([pending, bytes.subarray(start, end)]));
      else yield undefined;
      pending = Buffer.alloc(0);
      start = end + 1;
    }
    if (pending) {
      pending =
        pending.length + bytes.length - start <= MAX_RECORD
          ? Buffer.concat([pending, bytes.subarray(start)])
          : undefined;
    }
  }
  if (!pending || pending.length) yield parse(pending);
}

async function output(
  file: Awaited<ReturnType<typeof open>> | undefined,
  errorsOnly: boolean,
  out: StreamOutput,
) {
  let skipped = 0;
  let first = true;
  if (out.json) await out.write('{"ok":true,"entries":[');
  if (file) {
    try {
      for await (const entry of records(file)) {
        if (!entry) {
          skipped++;
          continue;
        }
        if (errorsOnly && entry.level !== "error") continue;
        if (out.json) await out.write((first ? "" : ",") + JSON.stringify(entry));
        else
          await out.write(
            `${new Date(entry.time).toISOString()} [${entry.source}/${entry.level}] ${entry.text}\n`,
          );
        first = false;
      }
    } catch (error) {
      await out.notice(
        `Could not finish reading the plugin log: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  if (out.json) await out.write(`],"skipped":${skipped}}\n`);
  if (skipped && !out.json) await out.notice(`Skipped ${skipped} malformed log records.\n`);
  if (out.json) await out.notice("Read plugin log.\n");
}

async function logFolder() {
  if (process.env.TOKAMAK_PLUGIN_LOG_DIR) return process.env.TOKAMAK_PLUGIN_LOG_DIR;
  const data = dataFolder();
  const canonical = await realpath(data).catch(() => data);
  const key = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return join(tmpdir(), "tokamak", "logs", key);
}

export default {
  path: "plugin logs",
  summary: "Read a plugin log on this machine.",
  usesServer: true,
  args: { name: "id" },
  flags: { errors: { summary: "Show only errors." } },
  example: "tokamak plugin logs my-plugin --errors --json",
  async run([id], { flags, server }) {
    const unknown = () => new CommandError(`Unknown plugin: ${id}`, "tokamak plugin list");
    if (!id || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(id)) throw unknown();
    const file = await open(join(await logFolder(), `${id}.log`), "r").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (file && !(await file.stat()).isFile()) {
      await file.close();
      throw new CommandError(`Plugin log for ${id} is not a regular file`, "tokamak plugin list");
    }
    if (!file && !(await readIndex()).has(id)) {
      const catalog = (await serverGet("/plugins", server).catch(() => null)) as {
        plugins: { plugin: { id: string } }[];
      } | null;
      if (!catalog?.plugins.some((entry) => entry.plugin.id === id)) throw unknown();
    }
    return { stream: (out) => output(file, flags.errors === true, out) };
  },
} satisfies Command;
