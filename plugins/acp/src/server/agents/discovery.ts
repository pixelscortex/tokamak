import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export type Agent = { id: string; title: string; command: string; args: string[] };
export const BUILTINS: Agent[] = [
  { id: "claude", title: "claude", command: "claude-agent-acp", args: [] },
  { id: "codex", title: "codex", command: "codex-acp", args: [] },
  { id: "gemini", title: "gemini", command: "gemini", args: ["--acp"] },
];
export function searchPaths(): string[] {
  return [
    ...(process.env.PATH ?? "").split(delimiter),
    ...[".local/bin", ".npm-global/bin", ".bun/bin", ".local/share/vite-plus/bin", ".volta/bin"].map((p) =>
      join(homedir(), p),
    ),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}
export function resolveCommand(command: string, paths = searchPaths()): string | undefined {
  const candidates = isAbsolute(command) ? [command] : paths.filter(isAbsolute).map((p) => join(p, command));
  if (!isAbsolute(command) && command.includes("/")) return;
  return candidates.find((path) => {
    try {
      const directory = statSync(dirname(path));
      const file = statSync(path);
      return (
        directory.isDirectory() &&
        file.isFile() &&
        !(directory.mode & 0o022) &&
        !(file.mode & 0o022) &&
        !!(file.mode & 0o111) &&
        (file.uid === process.geteuid?.() || file.uid === 0)
      );
    } catch {
      return false;
    }
  });
}
export function discover(definitions = BUILTINS): Agent[] {
  return definitions.flatMap((agent) => {
    const command = resolveCommand(agent.command);
    return command ? [{ ...agent, command }] : [];
  });
}
export function checkFolder({ path: input }: { path: string }): string {
  const trimmed = input.trim();
  const path =
    !trimmed || trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/")
        ? join(homedir(), trimmed.slice(2))
        : trimmed;
  if (!isAbsolute(path)) throw new Error(`Agent folder must be an absolute path: ${input}`);
  let exists = false;
  try {
    exists = statSync(path).isDirectory();
  } catch {
    /* use the public error below */
  }
  if (!exists) throw new Error(`Agent folder does not exist: ${path}`);
  return path;
}
