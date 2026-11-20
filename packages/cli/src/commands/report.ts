import { arch, platform, release } from "node:os";
import { lstat, open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CommandError, type Command } from "../command";
import { dataFolder } from "../data";
import { readIndex } from "../plugin-index";
import { doctorTable, inspectDevelopment } from "./doctor";
import { serverGet } from "../server";

type Catalog = { plugins: { plugin: { id: string; version: string }; fromIndex?: boolean }[] };

function block(text: string) {
  return text
    ? text
        .split(/\r?\n/)
        .map((line) => `    ${line}`)
        .join("\n")
    : "(empty)";
}

async function logTail(path: string, count: number) {
  if (!(await lstat(path)).isFile()) return [];
  const file = await open(path, "r");
  try {
    let { size: offset } = await file.stat();
    const chunks: Buffer[] = [];
    let newlines = 0;
    while (offset && newlines <= count) {
      const size = Math.min(8192, offset);
      offset -= size;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, offset);
      const chunk = buffer.subarray(0, bytesRead);
      for (const byte of chunk) if (byte === 10) newlines++;
      chunks.push(chunk);
    }
    const lines = Buffer.concat(chunks.reverse()).toString("utf8").split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    // The first line may be partial when reading from the middle of the log.
    if (offset) lines.shift();
    return redactLog(lines, offset !== 0).slice(-count);
  } finally {
    await file.close();
  }
}

function redactTokenShapes(text: string) {
  // Tokamak's local and invite tokens are random 256-bit values in hex.
  return text.replace(/[a-f0-9]{64,}/gi, "[REDACTED]").replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[REDACTED]");
}

function redactLog(lines: string[], credential = false) {
  return lines.map((line) => {
    credential =
      /authorization|\b(?:bearer|basic)\s+|\btoken\b|tokamak_token|\/join#/i.test(line) ||
      (credential && /^\s/.test(line));
    return credential ? "[REDACTED: credential-bearing line]" : redactTokenShapes(line);
  });
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

async function loadedPlugins() {
  try {
    const { plugins } = (await serverGet("/plugins", undefined, {
      localOnly: true,
      timeout: 1000,
    })) as Catalog;
    return block(
      JSON.stringify(
        plugins.map(({ plugin: { id, version }, fromIndex }) => ({
          id,
          version,
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
    readIndex().then(
      (entries) => block(redactTokenShapes(JSON.stringify(Object.fromEntries(entries), null, 2))),
      () => "Could not read the plugin index.",
    ),
    logTail(join(folder, "server.log"), 200).then(
      (lines) => block(lines.join("\n")),
      () => "No readable server.log.",
    ),
    readLocalToken(folder),
  ]);
  const offline = "Local server is not running or reachable.";
  const plugins = server ? await loadedPlugins() : offline;
  let report = [
    "# Tokamak diagnostic report",
    "Redaction was applied to remove credential values and token-looking log text.",
    "## Doctor",
    block(
      doctorTable(
        rows.map((row) =>
          row.name === "Local server" ? row : { ...row, detail: redactTokenShapes(row.detail) },
        ),
      ),
    ),
    "## Local server",
    server
      ? block(
          `Address: ${server.url}\nBuild id: ${server.buildId}\nProcess id: ${server.pid}\nData folder: ${redactTokenShapes(folder)}`,
        )
      : offline,
    "## Loaded plugins",
    plugins,
    "## Plugin index",
    index,
    "## Operating system",
    block(`${platform()} ${release()} (${arch()})`),
    "## server.log (last 200 lines)",
    log,
  ].join("\n\n");
  for (const secret of new Set([localToken?.trim(), process.env.TOKAMAK_TOKEN])) {
    if (secret) report = report.replaceAll(secret, "[REDACTED]");
  }
  return report + "\n";
}

export default {
  path: "report",
  summary: "Write a redacted diagnostic report to a local file.",
  example: "tokamak report --out diagnostics.md",
  flags: { out: { value: "path", summary: "Where to write the report." } },
  async run(_, { flags }) {
    const timestamp = new Date().toISOString().replace(/:/g, "-");
    const path = resolve(typeof flags.out === "string" ? flags.out : `tokamak-report-${timestamp}.md`);
    const report = await reportText(dataFolder());
    try {
      await writeFile(path, report, { flag: "wx", mode: 0o600 });
    } catch (error) {
      const message =
        (error as NodeJS.ErrnoException).code === "EEXIST"
          ? "The report file already exists. Choose a different --out path."
          : "Could not write the report. Choose a writable --out path.";
      throw new CommandError(message, "tokamak report --help");
    }
    return { data: { path }, text: path };
  },
} satisfies Command;
