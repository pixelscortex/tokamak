/** MOCK DATA for the lab: the only place the lab's sample content lives.
 * Nothing here is real: no plugin, model or account is behind it. The
 * components (`@tokamak/ui`) take all of it through props. */
import type { ComposerCommand, ComposerContext, ComposerRun, SelectOption } from "@tokamak/ui/components";

/** Models for the composer's model select (grouped by provider). */
export const models: SelectOption[] = [
  { value: "claude", label: "claude", detail: "free", group: "Agents" },
  { value: "codex", label: "codex", detail: "auto", group: "Agents" },
  { value: "deepseek/r1", label: "deepseek/r1", detail: "64k", group: "Agents" },
  { value: "gpt-6.1", label: "gpt-6.1", detail: "1M", group: "ChatGPT" },
  { value: "gpt-6.1-mini", label: "gpt-6.1-mini", detail: "400k", group: "ChatGPT" },
  { value: "local/llama-5", label: "local/llama-5", detail: "offline", group: "Local", disabled: true },
  { value: "local/qwen-4", label: "local/qwen-4", detail: "32k", group: "Local" },
];

/** Options for the Select view (field size, with groups). */
export const lists: SelectOption[] = [
  { value: "inbox", label: "Inbox", group: "Todo" },
  { value: "today", label: "Today", group: "Todo" },
  { value: "groceries", label: "Weekend groceries", detail: "6", group: "Todo" },
  { value: "someday", label: "Someday", detail: "archived", group: "Todo", disabled: true },
  { value: "board", label: "Kitchen renovation", group: "Board" },
  { value: "receipts", label: "Receipts 2026", group: "Board" },
];

export const due: SelectOption[] = [
  { value: "none", label: "No date" },
  { value: "today", label: "Today" },
  { value: "friday", label: "Friday" },
  { value: "next-week", label: "Next week" },
];

export const priorities: SelectOption[] = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
];

/** Context chips attached to a message. */
export const context: ComposerContext[] = [
  { id: "milk", label: "Buy milk", detail: "Todo" },
  { id: "groceries", label: "Weekend groceries", detail: "Chat" },
  { id: "lease", label: "lease-2026.pdf", detail: "Files" },
  { id: "receipts", label: "Receipts folder", detail: "Files" },
  { id: "kitchen", label: "Kitchen renovation", detail: "Board" },
  { id: "dentist", label: "Dentist", detail: "Calendar" },
  { id: "friday", label: "Friday 09:00", detail: "Calendar" },
  { id: "budget", label: "Budget.numbers", detail: "Files" },
  { id: "notes", label: "Meeting notes", detail: "Notes" },
];

/** Commands the plugins offer (typing `/` in the composer). */
export const commands: ComposerCommand[] = [
  { name: "todo", description: "Create a task", source: "todo" },
  { name: "today", description: "What is due today", source: "todo" },
  { name: "board", description: "Add a card to a board", source: "board" },
  { name: "remind", description: "Remind me at a time", source: "calendar" },
  { name: "summarise", description: "Summarise a file or folder", source: "files" },
  { name: "search", description: "Search everything", source: "core" },
  { name: "model", description: "Switch the model for this chat", source: "core" },
  { name: "clear", description: "Start over in a new chat", source: "core" },
];

/** A run in progress. */
export const run: ComposerRun = {
  step: "Reading Weekend groceries",
  stepIndex: 2,
  stepCount: 5,
  elapsed: "14s",
  queued: "and add oat milk too",
};

/** The chat view's sample thread. */
export const thread = {
  title: "Milk, and a Friday nudge",
  started: "Today at 14:02",
  status: "Working, 14s",
  ask: "Add a todo to buy milk and remind me Friday",
  tool: { label: "Created a task in Todo", time: "0.4s" },
  task: { title: "Buy milk", due: "Fri 13 Nov, 09:00" },
  reply: [
    "is in your Todo inbox, due Friday 13 November at 09:00, and I’ll nudge you that morning.",
    "You also have “Weekend groceries” from this morning with six open items. Want me to fold milk into that list instead, so there is one shop to do",
  ],
};

/** The approval question. */
export const approval = {
  question: "Todo wants to add a task to your inbox.",
  detail: "todo.tasks.write",
};

export function todoFields(list: [string, (value: string) => void], date: [string, (value: string) => void]) {
  return [
    { id: "list", label: "List", options: lists, value: list[0], onChange: list[1] },
    { id: "due", label: "Due", options: due, value: date[0], onChange: date[1] },
  ];
}
