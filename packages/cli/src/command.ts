export interface Command {
  path: string;
  summary: string;
  example: string;
  args?: { name: string; optional?: boolean };
  run(args: string[], options: { server?: string }): Promise<{ data: object; text: string }>;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly next: string,
    readonly diagnostics?: object[],
    readonly data?: { plugins: object[] },
  ) {
    super(message);
  }
}
