import { CommandError } from "./command";
import { commands } from "./commands";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const help = argv.includes("--help");
const positional: string[] = [];
let server: string | undefined;
let next = "tokamak --help";

function output(data: object, human: string) {
  if (json) {
    process.stdout.write(JSON.stringify(data) + "\n");
    process.stderr.write(human + "\n");
  } else {
    process.stdout.write(human + "\n");
  }
}

try {
  for (const [i, arg] of argv.entries()) {
    if (arg === "--server") {
      if (server || !argv[i + 1] || argv[i + 1]!.startsWith("-"))
        throw new CommandError("Expected one address after --server", next);
      server = argv[i + 1];
    } else if (argv[i - 1] === "--server" || arg === "--help" || arg === "--json") {
      continue;
    } else if (arg.startsWith("-")) {
      throw new CommandError(`Unknown flag: ${arg}`, next);
    } else {
      positional.push(arg);
    }
  }
  const command = commands.find(({ path }) => path.split(" ").every((word, i) => positional[i] === word));
  if (command) next = `tokamak ${command.path} --help`;
  const args = command ? positional.slice(command.path.split(" ").length) : [];
  const group = positional.join(" ");
  const children = commands.filter(({ path }) => !group || path.startsWith(group + " "));
  if (command && args.length > Number(Boolean(command.args))) {
    throw new CommandError(`Unexpected argument: ${args.at(-1)}`, next);
  }
  if (help && (command || children.length)) {
    const text = command
      ? [
          `Usage: tokamak ${command.path}${command.args ? (command.args.optional ? ` [${command.args.name}]` : ` <${command.args.name}>`) : ""} [--json] [--server <address>] [--help]`,
          command.summary,
          `Example: ${command.example}`,
        ].join("\n")
      : [
          `Usage: tokamak ${group ? group + " " : ""}<command> [--json] [--server <address>] [--help]`,
          ...children.map(({ path, summary }) => `  ${path}  ${summary}`),
          `Example: ${children[0]!.example}`,
        ].join("\n");
    output({ ok: true, help: text }, text);
  } else {
    if (!command)
      throw new CommandError(group ? `Unknown or incomplete command: ${group}` : "Missing command", next);
    if (command.args && !command.args.optional && !args.length)
      throw new CommandError(`Missing argument: ${command.args.name}`, next);
    const { data, text } = await command.run(args, { server });
    output({ ok: true, ...data }, text);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CommandError) next = error.next;
  const diagnostics = error instanceof CommandError ? error.diagnostics : undefined;
  output(
    { ok: false, error: { message, next, ...(diagnostics ? { diagnostics } : {}) } },
    `${message}\nTry: ${next}`,
  );
  process.exitCode = 1;
}
