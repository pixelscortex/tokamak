/*
  <StatusIcon status="needs-you" label="Fix total rounding" />  → "Fix total rounding, needs you"

  One shape per state. Only needs you (amber) and failed (red) are coloured;
  running and done take the row's tone. The word is in the name, not on screen.
*/
import type { JSX } from "@solidjs/web";
import { cn, tv } from "./cn.ts";
import { Icon } from "./icon.tsx";
import { icons } from "./icons.ts";

export type Status = "running" | "needs-you" | "done" | "failed";

const shapes: Record<Status, { path: string; word: string }> = {
  running: { path: icons.running, word: "running" },
  "needs-you": { path: icons.needsYou, word: "needs you" },
  done: { path: icons.done, word: "done" },
  failed: { path: icons.failed, word: "failed" },
};

const statusVariants = tv({
  base: "inline-flex shrink-0",
  variants: {
    status: {
      running: "motion-safe:*:animate-spin",
      "needs-you": "text-warn",
      done: "",
      failed: "text-removed",
    },
  },
});

export function StatusIcon(props: {
  status: Status;
  label?: string;
  size?: 12 | 16;
  class?: string;
}): JSX.Element {
  const shape = () => shapes[props.status];
  return (
    <span data-slot="status-icon" class={cn(statusVariants({ status: props.status }), props.class)}>
      <Icon
        path={shape().path}
        size={props.size}
        label={props.label ? `${props.label}, ${shape().word}` : shape().word}
      />
    </span>
  );
}
