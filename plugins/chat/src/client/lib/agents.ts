import type { JsonValue } from "@tokamak/sdk";
import { glyphs, marks } from "./icons";

export type BackendOption = { id: string; plugin: string; title: string; folder?: boolean };
export type Backend = { kind: "plugin"; plugin: string; backendId: string; settings?: JsonValue };
export type Agent = { id: string; name: string; mark: string; folder: string };

const known: Record<string, { name: string; mark: string }> = {
  claude: { name: "Claude", mark: marks.claude },
  codex: { name: "Codex", mark: marks.openai },
  gemini: { name: "Gemini", mark: marks.gemini },
};

export function folderOf(settings: JsonValue | undefined): string {
  return settings &&
    typeof settings === "object" &&
    !Array.isArray(settings) &&
    typeof settings.cwd === "string"
    ? settings.cwd
    : "";
}

/** The last path segment, or "~" for the home folder the server resolves an empty path to. */
export function folderName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? (path ? "/" : "");
}

export function agentOf(backend: Backend | undefined, options?: BackendOption[]): Agent | undefined {
  if (!backend) return undefined;
  const option = options?.find((item) => item.id === backend.backendId && item.plugin === backend.plugin);
  const brand = known[backend.backendId];
  const title = option?.title ?? backend.backendId;
  return {
    id: backend.backendId,
    name: brand?.name ?? title.charAt(0).toUpperCase() + title.slice(1),
    mark: brand?.mark ?? glyphs.chat,
    folder: folderOf(backend.settings),
  };
}

export function optionAgent(option: BackendOption): Agent {
  return agentOf({ kind: "plugin", plugin: option.plugin, backendId: option.id }, [option])!;
}
