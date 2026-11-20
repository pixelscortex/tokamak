import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "../command";
import { serverGet } from "../server";
import { version } from "../../package.json";

const checkout = fileURLToPath(new URL("../../../../", import.meta.url));
const buildModule = new URL("../../../build/src/vite.ts", import.meta.url);
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

function toolVersion(executable: string, args: string[], env = process.env) {
  const result = spawnSync(executable, args, {
    cwd: checkout,
    env,
    encoding: "utf8",
    timeout: 2000,
  });
  return {
    version: result.status === 0 ? result.stdout.trim().split(/\r?\n/).at(-1) : undefined,
    missingExecutable: (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
  };
}

async function bunCheck() {
  const source = await readFile(join(checkout, ".prototools"), "utf8").catch(() => "");
  const pinned = /^bun\s*=\s*"([^"]+)"/m.exec(source)?.[1];
  if (!pinned) return missing("Bun", "No Bun version is pinned in this checkout.", "tokamak doctor --help");
  const { version: actual, missingExecutable } = toolVersion(
    "proto",
    ["run", "bun", pinned, "--", "--version"],
    {
      ...process.env,
      PROTO_AUTO_INSTALL: "false",
      PROTO_OFFLINE: "true",
      PROTO_TELEMETRY: "false",
    },
  );
  return actual === pinned
    ? ready("Bun", `${actual} via proto`)
    : missing(
        "Bun",
        `Pinned Bun ${pinned} is unavailable through proto.`,
        missingExecutable ? "https://moonrepo.dev/proto" : "proto install bun",
      );
}

async function buildCheck() {
  try {
    const resolve = createRequire(buildModule).resolve;
    for (const dependency of ["typescript", "@solidjs/vite-plugin", "tailwindcss/index.css"]) {
      resolve(dependency);
    }
    await import("../../../build/src/vite");
    return ready("Build tools", "TypeScript, the Solid compiler and Tailwind resolve from the checkout.");
  } catch {
    return missing(
      "Build tools",
      "The checkout's plugin build tools could not be loaded.",
      "proto run bun -- install",
    );
  }
}

type LocalServer = { url: string; buildId: string; pid: number };

async function localServer(): Promise<LocalServer | undefined> {
  try {
    const { url, buildId, pid } = (await serverGet("/health", undefined, {
      localOnly: true,
      timeout: 1000,
    })) as LocalServer;
    const address = new URL(url);
    if (
      address.protocol === "ws:" &&
      address.pathname === "/ws" &&
      !address.username &&
      !address.password &&
      !address.search &&
      !address.hash &&
      (address.hostname === "[::1]" ||
        (isIP(address.hostname) === 4 && address.hostname.startsWith("127."))) &&
      /^[a-f0-9]{64}$/.test(buildId) &&
      Number.isSafeInteger(pid) &&
      pid > 0
    ) {
      return { url, buildId, pid };
    }
  } catch {
    // Missing, stale or unreadable discovery is a failed readiness check.
  }
}

export async function inspectDevelopment() {
  const [bun, build, server] = await Promise.all([bunCheck(), buildCheck(), localServer()]);
  const { version: git } = toolVersion("git", ["--version"]);
  const rows = [
    ready("Tokamak CLI", `${version} · ${fileURLToPath(new URL("../main.ts", import.meta.url))}`),
    bun,
    git
      ? ready("git", git)
      : missing("git", "git is not available on PATH.", "https://git-scm.com/downloads"),
    build,
    server
      ? ready("Local server", `${server.url} · build id ${server.buildId}`)
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
