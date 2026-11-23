export interface LocalProcessOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

/** Output is decoded as UTF-8 and split on LF or CRLF. Each stream is read once. */
export interface RunningProcess {
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  readonly exited: Promise<number>;
  write(input: string | Uint8Array): void;
  closeInput(): void;
  stop(signal?: "SIGTERM" | "SIGKILL"): void;
}

/** Start an executable directly with an argument vector. No shell is implied. */
export type LocalProcess = (
  argv: readonly [string, ...string[]],
  options?: LocalProcessOptions,
) => RunningProcess;

export type WithPrograms = <T>(
  run: (forceStop: () => Promise<void>, context: import("./functions").LocalContext) => Promise<T>,
) => Promise<T>;
