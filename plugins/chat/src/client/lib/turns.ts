import type { Id, ResultOf } from "@tokamak/sdk";
import type { api } from "./api";

export type Message = ResultOf<typeof api.messages.list>[number];
export type Part = Message["parts"][number];
export type Tool = Extract<Part, { type: "tool" }>;
export type Plan = Extract<Part, { type: "plan" }>;
export type Permission = Extract<Part, { type: "permission" }>;

export type Step =
  | { kind: "tool"; key: string; label: string; status: "running" | "done" | "error"; error?: string }
  | { kind: "permission"; key: string; label: string; status: Permission["status"]; answer?: string };

export type Work = {
  steps: Step[];
  actions: number;
  running: boolean;
  waiting: boolean;
  failed: boolean;
  latest: string;
};

export function textOf(message: Message): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Text parts in order; tools and permissions fold into one work summary. */
export function foldTurn(message: Message): {
  texts: string[];
  work: Work | undefined;
  plan: Plan | undefined;
} {
  const texts: string[] = [];
  const steps: Step[] = [];
  let plan: Plan | undefined;
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.text.trim()) texts.push(part.text);
    } else if (part.type === "plan") plan = part;
    else if (part.type === "tool")
      steps.push({
        kind: "tool",
        key: `tool:${part.callId}`,
        label: stepLabel(part),
        status: part.status,
        ...(part.error ? { error: part.error } : {}),
      });
    else
      steps.push({
        kind: "permission",
        key: `permission:${part.requestId}`,
        label: part.title,
        status: part.status,
        ...(part.optionId
          ? { answer: part.options.find((option) => option.optionId === part.optionId)?.name }
          : {}),
      });
  }
  const streaming = message.status === "streaming";
  const waiting = steps.some((step) => step.kind === "permission" && step.status === "pending");
  const running = steps.filter((step) => step.status === "running");
  const work =
    steps.length || streaming
      ? {
          steps,
          actions: steps.filter((step) => step.kind === "tool").length,
          running: streaming,
          waiting,
          failed: steps.some((step) => step.status === "error"),
          latest: waiting
            ? "Waiting for you"
            : (running.at(-1)?.label ?? (steps.length ? steps.at(-1)!.label : "Working")),
        }
      : undefined;
  return { texts, work, plan };
}

export function stepLabel(tool: Tool): string {
  const summary = tool.summary?.trim();
  if (summary) return summary;
  const name = tool.toolName.replace(/[_.-]+/g, " ").trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "Tool call";
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** A running timer: 0:04, 1:12, 1:02:03. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** An age for a row trail: now, 4m, 3h, 2d, 5w. */
export function age(time: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - time) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`;
  return `${Math.floor(minutes / 10080)}w`;
}

export function timeOfDay(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Allow options first, so the main action is the first allow. */
export function permissionOptions(part: Permission) {
  return [...part.options].sort(
    (a, b) => Number(b.kind.startsWith("allow")) - Number(a.kind.startsWith("allow")),
  );
}

export function pendingPermission(messages: readonly Message[] | undefined) {
  for (const message of [...(messages ?? [])].reverse())
    for (const part of [...message.parts].reverse())
      if (part.type === "permission" && part.status === "pending" && part.optionId === undefined)
        return { messageId: message._id as Id<"messages">, part };
  return undefined;
}

export function lastReply(messages: readonly Message[] | undefined): string {
  const reply = [...(messages ?? [])].reverse().find((message) => message.role === "assistant");
  return reply ? textOf(reply) : "";
}

/** The user message a failed reply answered, so retry can send it again. */
export function promptBefore(messages: readonly Message[], id: string): string | undefined {
  const index = messages.findIndex((message) => message._id === id);
  for (let at = index - 1; at >= 0; at--) if (messages[at]!.role === "user") return textOf(messages[at]!);
  return undefined;
}
