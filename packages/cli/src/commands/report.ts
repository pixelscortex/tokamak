import { randomBytes } from "node:crypto";
import { arch, platform, release } from "node:os";
import { lstat, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CommandError, type Command } from "../command";
import { dataFolder } from "../data";
import { readIndex } from "../plugin-index";
import { doctorTable, inspectDevelopment } from "./doctor";
import { serverGetAt } from "../server";
import { reportSanitizer } from "./report-sanitize";

type Catalog = { plugins: { plugin: { id: string; version: string }; fromIndex?: boolean }[] };

function block(text: string) {
  return text
    ? text
        .split(/\r?\n/)
        .map((line) => `    ${line}`)
        .join("\n")
    : "(empty)";
}

const logLimit = 1024 * 1024;

async function logTail(path: string, count: number) {
  if (!(await lstat(path)).isFile()) return;
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - logLimit);
    const buffer = Buffer.alloc(size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, start + filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    const lines = buffer.toString("utf8", 0, filled).split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    // A byte cut can land in a message or even in the middle of a character.
    if (start > 0) lines.shift();
    return {
      lines: lines.slice(-count),
      notice:
        start > 0
          ? "Log tail limited to the last 1 MiB."
          : lines.length > count
            ? "Earlier log lines were omitted."
            : undefined,
    };
  } finally {
    await file.close();
  }
}

async function readLocalToken(folder: string) {
  const path = join(folder, "server.token");
  try {
    const metadata = await lstat(path);
    if (metadata.isFile() && metadata.size <= 4096) return await readFile(path, "utf8");
  } catch {
    // A stopped server may have no token file. Log patterns still get redacted.
  }
}

async function loadedPlugins(
  server: NonNullable<Awaited<ReturnType<typeof inspectDevelopment>>["server"]>,
  clean: (value: string) => string,
) {
  try {
    const { plugins } = (await serverGetAt("/plugins", server.endpoint)) as Catalog;
    return block(
      JSON.stringify(
        plugins.map(({ plugin: { id, version }, fromIndex }) => ({
          id: clean(id),
          version: clean(version),
          fromIndex: fromIndex === true,
        })),
        null,
        2,
      ),
    );
  } catch {
    return "Could not read the local server's loaded plugins.";
  }
}

async function reportText(folder: string) {
  const [{ rows, server }, index, log, localToken] = await Promise.all([
    inspectDevelopment(),
    readIndex(folder).catch(() => undefined),
    logTail(join(folder, "server.log"), 200).catch(() => undefined),
    readLocalToken(folder),
  ]);
  const clean = reportSanitizer([localToken?.trim(), process.env.TOKAMAK_TOKEN]);
  const offline = "Local server is not running or reachable.";
  const plugins = server ? await loadedPlugins(server, clean.value) : offline;
  return [
    "# Tokamak diagnostic report",
    "This file contains development checks, local server details, loaded plugins, the plugin index, operating system information, and a filtered server log tail. Paths and log text can include project names and other personal details. Redaction was applied to known credentials and credential-looking values. Review the file before sharing it.",
    "## Doctor",
    block(
      doctorTable(
        rows.map((row) => {
          const detail =
            row.name === "Local server" && server
              ? `${clean.value(server.identity.url)} · build id ${clean.buildId(server.identity.buildId)}`
              : clean.value(row.detail);
          return row.state === "not ready"
            ? { ...row, detail, fix: clean.value(row.fix) }
            : { ...row, detail };
        }),
      ),
    ),
    "## Local server",
    block(
      [
        `Data folder: ${clean.value(folder)}`,
        ...(server
          ? [
              `Address: ${clean.value(server.identity.url)}`,
              `Build id: ${clean.buildId(server.identity.buildId)}`,
              `Process id: ${clean.value(String(server.identity.pid))}`,
            ]
          : [offline]),
      ].join("\n"),
    ),
    "## Loaded plugins",
    plugins,
    "## Plugin index",
    index
      ? block(
          JSON.stringify(
            Object.fromEntries([...index].map(([id, path]) => [clean.value(id), clean.indexPath(path)])),
            null,
            2,
          ),
        )
      : "Could not read the plugin index.",
    "## Operating system",
    block(clean.value(`${platform()} ${release()} (${arch()})`)),
    "## server.log (last 200 lines)",
    log
      ? [log.notice, block(log.lines.map(clean.logLine).join("\n"))].filter(Boolean).join("\n\n")
      : "No readable server.log.",
    "",
  ].join("\n\n");
}

const reportHelp = "tokamak report --help";
const unwritable = "Could not write the report. Choose a writable --out path.";

async function reserveReport(out: string | undefined) {
  const timestamp = new Date().toISOString().replace(/:/g, "-");
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = attempt ? `-${randomBytes(4).toString("hex")}` : "";
    const path = resolve(out ?? `tokamak-report-${timestamp}${suffix}.md`);
    try {
      return { path, file: await open(path, "wx", 0o600) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new CommandError(unwritable, reportHelp);
      if (out !== undefined) {
        throw new CommandError("The report file already exists. Choose a different --out path.", reportHelp);
      }
    }
  }
  throw new CommandError("Could not reserve a default report name. Choose an --out path.", reportHelp);
}

export default {
  path: "report",
  summary: "Write a redacted diagnostic report to a local file.",
  example: "tokamak report --out diagnostics.md",
  flags: { out: { value: "path", summary: "Where to write the report." } },
  async run(_, { flags }) {
    const { path, file } = await reserveReport(typeof flags.out === "string" ? flags.out : undefined);
    try {
      await file.writeFile(await reportText(dataFolder()));
    } catch {
      throw new CommandError(unwritable, reportHelp);
    } finally {
      await file.close();
    }
    return { data: { path }, text: path };
  },
} satisfies Command;
