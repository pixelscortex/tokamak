import { CommandError, type Flags } from "./command";
import { commands } from "./commands";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const help = argv.includes("--help");
const positional: string[] = [];
let server: string | undefined;
const flags: Flags = {};
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
  // Pass 1 finds the command from the leading words, because which flags are
  // allowed depends on the command. Values of `--server` are skipped; a value of
  // a command flag can only follow the command's own words, so it cannot change
  // which command matches.
  const words = argv.filter((arg, i) => !arg.startsWith("-") && argv[i - 1] !== "--server");
  const command = commands
    .filter(({ path }) => path.split(" ").every((word, i) => words[i] === word))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (command) next = `tokamak ${command.path} --help`;
  const declared = Object.entries(command?.flags ?? {});

  // Pass 2 reads every token against the flags that command declares.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "--json") continue;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const found = declared.find(
      ([name, flag]) => arg === `--${name}` || (flag.short && arg === `-${flag.short}`),
    );
    const name = arg === "--server" ? "server" : found?.[0];
    if (!name) throw new CommandError(`Unknown flag: ${arg}`, next);
    if (name in flags || (name === "server" && server))
      throw new CommandError(`${arg} was given twice`, next);
    if (name === "server" || found?.[1].value) {
      const value = argv[++i];
      const placeholder = name === "server" ? "address" : found![1].value;
      if (!value || value.startsWith("-"))
        throw new CommandError(`Expected <${placeholder}> after ${arg}`, next);
      if (name === "server") server = value;
      else flags[name] = value;
    } else {
      flags[name] = true;
    }
  }
  const args = command ? positional.slice(command.path.split(" ").length) : [];
  const group = positional.join(" ");
  const children = commands.filter(({ path }) => !group || path.startsWith(group + " "));
  if (command && args.length > Number(Boolean(command.args))) {
    throw new CommandError(`Unexpected argument: ${args.at(-1)}`, next);
  }
  if (help && (command || children.length)) {
    const text = command
      ? [
          `Usage: tokamak ${command.path}${command.args ? (command.args.optional ? ` [${command.args.name}]` : ` <${command.args.name}>`) : ""}${declared.map(([name, flag]) => ` [--${name}${flag.value ? ` <${flag.value}>` : ""}]`).join("")} [--json] [--server <address>] [--help]`,
          command.summary,
          ...declared.map(
            ([name, flag]) =>
              `  ${flag.short ? `-${flag.short}, ` : ""}--${name}${flag.value ? ` <${flag.value}>` : ""}  ${flag.summary}`,
          ),
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
    const { data, text } = await command.run(args, { server, flags });
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
