import type { LocalProcess, LocalProcessOptions, RunningProcess } from "../src/local";

export type SpawnProgram = (
  argv: readonly [string, ...string[]],
  options?: LocalProcessOptions,
) => Omit<RunningProcess, "stop"> & {
  stop(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
};

export function invocationProcesses(signal: AbortSignal, spawn: SpawnProgram) {
  const active = new Set<(signal?: "SIGKILL") => Promise<void>>();
  let closed = false;
  const onAbort = () => void close();
  async function close(signalName?: "SIGKILL") {
    closed = true;
    signal.removeEventListener("abort", onAbort);
    await Promise.allSettled([...active].map((stop) => stop(signalName)));
  }
  signal.addEventListener("abort", onAbort, { once: true });
  const start: LocalProcess = ([command, ...args], options) => {
    if (closed || signal.aborted) throw new Error("Caller action cancelled");
    const program = spawn([command, ...args], options);
    const stop = (signal?: "SIGTERM" | "SIGKILL") =>
      program.stop(signal).finally(() => active.delete(finish));
    const finish = async (force?: "SIGKILL") => {
      if (options?.finishOnCancel && !force) {
        await program.exited.catch(() => {});
        await stop();
      } else {
        await stop(force);
      }
    };
    active.add(finish);
    void program.exited.then(
      () => stop(),
      () => stop(),
    );
    return {
      ...program,
      stop: (signal) => {
        void stop(signal);
      },
    };
  };
  return {
    start,
    close,
  };
}
