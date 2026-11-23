import type { LocalProcessOptions } from "../src/local";
import type { SpawnProgram } from "./program-scope";

interface Program {
  stdout(): Promise<string[]>;
  stderr(): Promise<string[]>;
  exit(): Promise<number>;
  write(input: Uint8Array): void;
  closeInput(): void;
  stop(force: boolean): void;
  stopped(): Promise<void>;
}

export type NativeSpawn = (
  call: number,
  argv: readonly string[],
  options: LocalProcessOptions,
) => Program | { error: string };

async function* lines(read: () => Promise<string[]>) {
  for (;;) {
    const batch = await read();
    if (!batch.length) return;
    for (let index = 0; index < batch.length; index++) yield batch[index]!;
  }
}

export function quickJsPrograms(spawn: NativeSpawn, call: number): SpawnProgram {
  const encode = new TextEncoder();
  return (argv, options) => {
    const program = spawn(call, argv, options ?? {});
    if ("error" in program) {
      return {
        stdout: lines(async () => []),
        stderr: lines(async () => []),
        exited: Promise.reject(new Error(program.error)),
        write() {},
        closeInput() {},
        stop: async () => {},
      };
    }

    let stopping: Promise<void> | undefined;
    return {
      stdout: lines(program.stdout),
      stderr: lines(program.stderr),
      exited: program.exit(),
      write: (input) => program.write(typeof input === "string" ? encode.encode(input) : input),
      closeInput: program.closeInput,
      stop(signal) {
        program.stop(signal === "SIGKILL");
        return (stopping ??= program.stopped());
      },
    };
  };
}
