/*
  <StatusIcon status="needs-you" />
  <StatusIcon status="running" label="Add CSV export" />  → "Add CSV export, running"

  Status is an icon with one shape per state: a spinner for running, a lock
  for needs you, a check for done, a cross for failed. Only needs you
  (amber) and failed (red) are coloured; running and done take the tone of
  the row (tertiary idle, ink when current). The word lives in the
  accessible name, never on screen.
  Slots: none. data-slot="status-icon", data-status.
*/
import type { JSX } from "@solidjs/web";
import { Icon } from "./icon.tsx";
import { icons } from "./icons.ts";

export type Status = "running" | "needs-you" | "done" | "failed";

const shapes: Record<Status, { path: string; word: string }> = {
  running: { path: icons.running, word: "running" },
  "needs-you": { path: icons.needsYou, word: "needs you" },
  done: { path: icons.done, word: "done" },
  failed: { path: icons.failed, word: "failed" },
};

export function StatusIcon(props: { status: Status; label?: string; size?: 12 | 16 }): JSX.Element {
  const shape = () => shapes[props.status];
  return (
    <span data-slot="status-icon" data-status={props.status}>
      <Icon
        path={shape().path}
        size={props.size}
        label={props.label ? `${props.label}, ${shape().word}` : shape().word}
      />
    </span>
  );
}
