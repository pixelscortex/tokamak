import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandError, type Command } from "../command";
import { dataFolder } from "../data";
import { ensure, status, stop } from "../local-server";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const buildCommand = "cargo build --locked -p server --bin tokamak-server";

function serverBinary() {
  const target = resolve(root, process.env.CARGO_TARGET_DIR ?? "target");
  const name = process.platform === "win32" ? "tokamak-server.exe" : "tokamak-server";
  const binary = ["debug", "release"].map((profile) => resolve(target, profile, name)).find(existsSync);
  if (!binary) throw new CommandError("Local server executable is missing", buildCommand);
  return binary;
}

function details({ url, pid, buildId }: { url: string; pid: number; buildId?: string }) {
  return { address: url, pid, buildId: buildId ?? null };
}

function localOnly(server?: string) {
  if (server) throw new CommandError("This command only manages the local server", "tokamak server --help");
}

export const serverStart = {
  path: "server start",
  summary: "Start or reuse the local server.",
  example: "tokamak server start --json",
  async run(_, { server }) {
    localOnly(server);
    const binary = serverBinary();
    const probe = spawnSync(binary, ["--build-id"], { encoding: "utf8", windowsHide: true });
    const buildId = probe.stdout?.trim();
    if (probe.status !== 0 || !buildId || !/^[a-f0-9]{64}$/i.test(buildId))
      throw new CommandError("Cannot read the local server build id", buildCommand);
    const plugins = await realpath(process.env.TOKAMAK_PLUGIN_DIR ?? resolve(root, "plugins"));
    let started;
    try {
      started = await ensure(binary, plugins, buildId, dataFolder());
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error), "tokamak server stop");
    }
    const { address, pid } = details(started.identity);
    return {
      data: { address, pid, buildId, reused: started.reused },
      text: `${started.reused ? "Reusing" : "Started"} local server at ${address} (pid ${pid}, build id ${buildId}).`,
    };
  },
} satisfies Command;

export const serverStatus = {
  path: "server status",
  summary: "Show whether the local server is running.",
  example: "tokamak server status --json",
  async run(_, { server }) {
    localOnly(server);
    const identity = await status(dataFolder());
    if (!identity) return { data: { running: false }, text: "Local server is not running." };
    const { address, pid, buildId } = details(identity);
    return {
      data: { running: true, address, pid, buildId },
      text: `Local server is running at ${address} (pid ${pid}, build id ${buildId ?? "unknown"}).`,
    };
  },
} satisfies Command;

export const serverStop = {
  path: "server stop",
  summary: "Stop the local server.",
  example: "tokamak server stop --json",
  async run(_, { server }) {
    localOnly(server);
    const stopped = await stop(dataFolder());
    return {
      data: { stopped },
      text: stopped ? "Local server stopped." : "Local server is not running.",
    };
  },
} satisfies Command;
