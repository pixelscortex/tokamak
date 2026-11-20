import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "../command";
import { dataFolder } from "../data";
import { inspectLocalServer } from "../server";
import { tokamakVersion } from "../../../tokamak-version";

const checkout = fileURLToPath(new URL("../../../../", import.meta.url));
const startServer = "tokamak server start";

type Row = { name: string; detail: string } & (
  | { state: "ready"; fix?: never }
  | { state: "not ready"; fix: string }
);

function ready(name: string, detail: string): Row {
  return { name, state: "ready", detail };
}

function missing(name: string, detail: string, fix: string): Row {
  return { name, state: "not ready", detail, fix };
}

function gitVersion() {
  const result = spawnSync("git", ["--version"], {
    cwd: checkout,
    encoding: "utf8",
    timeout: 2000,
  });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/).at(-1) : undefined;
}

async function bunCheck() {
  const source = await readFile(join(checkout, ".prototools"), "utf8").catch(() => "");
  const pinned = /^bun\s*=\s*"(\d+\.\d+\.\d+)"/m.exec(source)?.[1];
  const actual = process.versions.bun;
  if (!pinned) {
    return missing(
      "Bun",
      `Running Bun ${actual}; the checkout's Bun pin is missing or invalid.`,
      "git restore -- .prototools",
    );
  }
  const detail = `Running Bun ${actual}; checkout pins ${pinned}.`;
  return actual === pinned ? ready("Bun", detail) : missing("Bun", detail, `proto install bun ${pinned}`);
}

async function buildCheck() {
  try {
    const { checkBuildTools } = await import("../../../build/src/check-tools");
    await checkBuildTools();
    return ready("Build tools", "TypeScript, the Solid compiler and Tailwind passed in-memory builds.");
  } catch (error) {
    return missing(
      "Build tools",
      (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " "),
      "proto run bun -- install --frozen-lockfile --force",
    );
  }
}

export async function inspectDevelopment() {
  const [bun, build, discovery] = await Promise.all([
    bunCheck(),
    buildCheck(),
    inspectLocalServer(dataFolder()).catch(() => undefined),
  ]);
  const server = discovery?.responsive ? discovery : undefined;
  const git = gitVersion();
  const rows = [
    ready("Tokamak CLI", `${tokamakVersion()} · ${fileURLToPath(new URL("../main.ts", import.meta.url))}`),
    bun,
    git
      ? ready("git", git)
      : missing("git", "git is not available on PATH.", "https://git-scm.com/downloads"),
    build,
    server
      ? ready("Local server", `${server.identity.url} · build id ${server.identity.buildId ?? "unknown"}`)
      : missing("Local server", "Local server is not running or reachable.", startServer),
  ];
  return { rows, server };
}

export function doctorTable(rows: Row[]) {
  return [
    "Check          State      Detail",
    ...rows.map(
      ({ name, state, detail, fix }) =>
        `${name.padEnd(15)}${state.padEnd(11)}${detail.replace(/\s+/g, " ")}${fix ? `  Fix: ${fix}` : ""}`,
    ),
  ].join("\n");
}

export default {
  path: "doctor",
  summary: "Check this machine for plugin development.",
  example: "tokamak doctor --json",
  async run() {
    const { rows } = await inspectDevelopment();
    const firstFailure = rows.find((row) => row.state === "not ready");
    const error = firstFailure && {
      message: "Some development checks are not ready.",
      next: firstFailure.fix,
    };
    const text = doctorTable(rows);
    return { data: { rows }, text: error ? `${text}\n\n${error.message}\nTry: ${error.next}` : text, error };
  },
} satisfies Command;
