/**
 * A flag that belongs to one command, written `--name` on the command line.
 * `value` is the placeholder shown in help (`--out <path>`); a flag without it
 * is a switch. `short` adds a one-letter form (`-t`).
 */
export interface Flag {
  summary: string;
  value?: string;
  short?: string;
}

/** The flags a command received: a switch is `true`, a flag with a value holds that value. */
export type Flags = Record<string, string | true>;

export interface StreamOutput {
  json: boolean;
  write(text: string): Promise<void>;
  notice(text: string): Promise<void>;
}

export interface Command {
  path: string;
  summary: string;
  example: string;
  args?: { name: string; optional?: boolean };
  /** Accept the shared `--server` option on this command. */
  usesServer?: boolean;
  /** Flags only this command accepts. `--json` and `--help` work on every command. */
  flags?: Record<string, Flag>;
  run(
    args: string[],
    options: { server?: string; flags: Flags },
  ): Promise<
    { data: object; text: string; jsonText?: string } | { stream(output: StreamOutput): Promise<void> }
  >;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly next: string,
    readonly diagnostics?: object[],
    readonly data?: object,
  ) {
    super(message);
  }
}
