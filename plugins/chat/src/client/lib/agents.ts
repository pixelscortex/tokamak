import type { JsonValue } from "@tokamak/sdk";
import { glyphs, marks } from "./icons";

export type BackendOption = { id: string; plugin: string; title: string; folder?: boolean };
export type Backend = { kind: "plugin"; plugin: string; backendId: string; settings?: JsonValue };
/** `mark` is the bundled path, shown until (or instead of, when unavailable) the `logo` URL loads. */
export type Agent = { id: string; name: string; mark: string; logo?: string; folder: string };

const known: Record<string, { name: string; mark: string; logo: string }> = {
  claude: { name: "Claude", mark: marks.claude, logo: "claude" },
  codex: { name: "Codex", mark: marks.openai, logo: "codex" },
  gemini: { name: "Gemini", mark: marks.gemini, logo: "gemini" },
};

// LobeHub's single-colour brand icons (MIT). The version is pinned so each URL never
// changes and the browser can keep it cached; the CDN serves them for a year.
const LOGOS = "https://unpkg.com/@lobehub/icons-static-svg@1.104.0/icons/";

/** The LobeHub icon URL for an agent ID, guessing the slug for agents not listed above. */
export function logoOf(backendId: string): string | undefined {
  const slug = known[backendId]?.logo ?? backendId.toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) ? `${LOGOS}${slug}.svg` : undefined;
}

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
  const logo = logoOf(backend.backendId);
  return {
    id: backend.backendId,
    name: brand?.name ?? title.charAt(0).toUpperCase() + title.slice(1),
    mark: brand?.mark ?? glyphs.chat,
    ...(logo ? { logo } : {}),
    folder: folderOf(backend.settings),
  };
}

/**
 * The agent that wrote a reply, from the agent recorded on its message. It resolves
 * whether or not this viewer has that agent installed: in a shared thread a reply
 * may come from someone else's computer. Known agents get their own name and mark;
 * others get their recorded ID and the generic mark. Only an unrecorded (older)
 * reply gets undefined, which the turn shows as "Agent".
 */
export function replyAgent(
  recorded: { plugin: string; backendId: string } | undefined,
  options: BackendOption[] | undefined,
): Agent | undefined {
  return recorded ? agentOf({ kind: "plugin", ...recorded }, options) : undefined;
}

export function optionAgent(option: BackendOption): Agent {
  return agentOf({ kind: "plugin", plugin: option.plugin, backendId: option.id }, [option])!;
}
