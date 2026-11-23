import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";
import type { Duplex, Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { invocationProcesses as ownPrograms, type SpawnProgram } from "./program-scope";
import { WORKER_FRAME_BYTES } from "../src/worker-limits";

// FD 3 belongs to a watchdog in the program's group. EOF stops the group
// even when Bun is killed or cannot run its cleanup. The executable gets
// the caller's exact argument vector and does not inherit the liveness pipe.
const groupEntry = `
  ( trap '' TERM
    while IFS= read -r line; do :; done
    kill -TERM "-$$" 2>/dev/null
    /bin/sleep 0.25
    kill -KILL "-$$" 2>/dev/null
  ) <&3 >/dev/null 2>&1 &
  exec 3<&-
  exec "$@"
`;

async function* lines(stream: Readable) {
  const decoder = new StringDecoder("utf8");
  let tail = "";
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    const parts = (tail + decoder.write(chunk)).split("\n");
    tail = parts.pop()!;
    for (const line of parts) yield line.endsWith("\r") ? line.slice(0, -1) : line;
    if (tail.length > WORKER_FRAME_BYTES) throw new Error("Program output line exceeds 1 MiB");
  }
  tail += decoder.end();
  if (tail) yield tail;
}

function stopWindowsTree(pid: number): Promise<boolean> {
  const root = process.env.SYSTEMROOT ?? process.env.SystemRoot;
  const taskkill = root ? join(root, "System32", "taskkill.exe") : "taskkill.exe";
  return new Promise((resolve) => {
    // Use the program PID while its descendants still belong to it. The
    // client's enclosing job object remains the fallback on worker exit.
    const command = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    command.once("error", () => resolve(false));
    command.once("exit", (code) => resolve(code === 0));
  });
}

export function invocationProcesses(signal: AbortSignal) {
  return ownPrograms(signal, spawnProgram);
}

const spawnProgram: SpawnProgram = ([command, ...args], options) => {
  const windows = process.platform === "win32";
  const child = windows
    ? spawn(command, args, { ...options, stdio: "pipe", windowsHide: true })
    : spawn("/bin/sh", ["-c", groupEntry, "tokamak-program", command, ...args], {
        ...options,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        detached: true,
      });
  const guard = child.stdio[3] as Duplex | undefined;
  const groupExited =
    guard &&
    new Promise<void>((resolve) => {
      guard.on("error", () => {});
      guard.once("close", resolve);
    });
  // Exiting before reading stdin is normal, including during cancellation.
  child.stdin!.on("error", () => {});
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? 128 + (constants.signals[signal!] ?? 0)));
  });
  let stopping: Promise<void> | undefined;
  function stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
    const pid = child.pid;
    if (guard && signal === "SIGKILL" && pid && !guard.destroyed) {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    return (stopping ??= (async () => {
      if (guard) {
        guard.end();
        await groupExited;
      } else if (pid && child.exitCode === null && child.signalCode === null) {
        if (!(await stopWindowsTree(pid))) child.kill(signal);
      }
      await exited.catch(() => {});
    })());
  }
  return {
    stdout: lines(child.stdout!),
    stderr: lines(child.stderr!),
    exited,
    write: (data) => {
      child.stdin!.write(data);
    },
    closeInput: () => {
      child.stdin!.end();
    },
    stop,
  };
};
