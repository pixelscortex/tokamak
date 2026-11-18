import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";

export type Agent = { id: string; title: string; command: string; args: string[] };
export const BUILTINS: Agent[] = [
  { id: "claude", title: "claude", command: "claude-agent-acp", args: [] },
  { id: "codex", title: "codex", command: "codex-acp", args: [] },
  { id: "gemini", title: "gemini", command: "gemini", args: ["--acp"] },
];
function agentHome(): string {
  return process.platform === "win32" ? process.env.USERPROFILE || homedir() : homedir();
}

export function searchPaths(): string[] {
  const paths = (process.env.PATH ?? "").split(delimiter);
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    return [
      ...paths.map((entry) => entry.replace(/^"(.*)"$/, "$1")),
      ...(appdata ? [join(appdata, "npm")] : []),
      ...[".bun/bin", ".volta/bin"].map((path) => join(agentHome(), path)),
    ];
  }
  return [
    ...paths,
    ...[".local/bin", ".npm-global/bin", ".bun/bin", ".local/share/vite-plus/bin", ".volta/bin"].map((p) =>
      join(homedir(), p),
    ),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}
export function resolveCommand(command: string, paths = searchPaths()): string | undefined {
  const windows = process.platform === "win32";
  const absolute = isAbsolute(command);
  if (!absolute && (windows ? /[\\/:]/.test(command) : command.includes("/"))) return;
  let candidates = absolute ? [command] : paths.filter(isAbsolute).map((p) => join(p, command));
  if (windows) {
    const extensions = [".exe", ".cmd", ".bat"];
    const extension = extname(command).toLowerCase();
    if (extension && !extensions.includes(extension)) return;
    if (!extension) candidates = candidates.flatMap((path) => extensions.map((ext) => path + ext));
  }
  return candidates.find((path) => {
    try {
      const directory = statSync(dirname(path));
      const file = statSync(path);
      if (!directory.isDirectory() || !file.isFile()) return false;
      if (windows) return true;
      return (
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
      ? agentHome()
      : trimmed.startsWith("~/") || (process.platform === "win32" && trimmed.startsWith("~\\"))
        ? join(agentHome(), trimmed.slice(2))
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
