import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandError, type Command } from "../command";
import { dataFolder } from "../data";
import { ensure, localServerEnv, stop } from "../local-server";
import { inspectLocalServer } from "../server";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const buildCommand = "cargo build --locked -p server --bin tokamak-server";

function serverBinary() {
  const target = resolve(root, process.env.CARGO_TARGET_DIR ?? "target");
  const name = process.platform === "win32" ? "tokamak-server.exe" : "tokamak-server";
  const binary = ["debug", "release"].map((profile) => resolve(target, profile, name)).find(existsSync);
  if (!binary) throw new CommandError("Local server executable is missing", buildCommand);
  return binary;
}

function details({ url, pid, buildId }: { url: string; pid: number; buildId: string | null }) {
  return { address: url, pid, buildId: buildId ?? null };
}

export const serverStart = {
  path: "server start",
  summary: "Start or reuse the local server.",
  example: "tokamak server start --json",
  async run() {
    const binary = serverBinary();
    const probe = spawnSync(binary, ["--build-id"], {
      encoding: "utf8",
      windowsHide: true,
      env: localServerEnv(),
    });
    const buildId = probe.stdout?.trim();
    if (probe.status !== 0 || !buildId || !/^[a-f0-9]{64}$/i.test(buildId))
      throw new CommandError("Cannot read the local server build id", buildCommand);
    const pluginFolder = process.env.TOKAMAK_PLUGIN_DIR ?? resolve(root, "plugins");
    const plugins = await realpath(pluginFolder).catch(() => {
      throw new CommandError(
        "Cannot open the plugins folder",
        "Set TOKAMAK_PLUGIN_DIR to an existing plugins folder",
      );
    });
    let started;
    try {
      started = await ensure(binary, plugins, buildId, dataFolder());
    } catch (error) {
      if (error instanceof CommandError) throw error;
      throw new CommandError(
        error instanceof Error ? error.message : "Local server startup failed",
        `Inspect ${resolve(dataFolder(), "server.log")}`,
      );
    }
    const { address, pid } = details(started.identity);
    return {
      data: { address, pid, buildId, reused: started.reused },
      text: `${started.reused ? "Reusing" : "Started"} local server at ${address} (pid ${pid}, server build id ${buildId}).`,
    };
  },
} satisfies Command;

export const serverStatus = {
  path: "server status",
  summary: "Show whether the local server is running.",
  example: "tokamak server status --json",
  async run() {
    const server = await inspectLocalServer(dataFolder());
    if (!server) return { data: { running: false }, text: "Local server is not running." };
    const { address, pid, buildId } = details(server.identity);
    return {
      data: { running: true, responsive: server.responsive, address, pid, buildId },
      text: `Local server is running at ${address} (pid ${pid}, server build id ${buildId ?? "unknown"}).${server.responsive ? "" : " It is not responding."}`,
    };
  },
} satisfies Command;

export const serverStop = {
  path: "server stop",
  summary: "Stop the local server.",
  example: "tokamak server stop --json",
  async run() {
    const stopped = await stop(dataFolder());
    return {
      data: { stopped },
      text: stopped ? "Local server stopped." : "Local server is not running.",
    };
  },
} satisfies Command;
