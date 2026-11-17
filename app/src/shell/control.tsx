import type { JSX } from "@solidjs/web";
import { Kbd, Tooltip } from "@tokamak/ui";
import { shortcutName } from "./shortcuts";

/** A quiet 32 px icon button whose tooltip names it and shows its keys. */
export function Control(props: {
  icon: string;
  label: string;
  keys?: string;
  disabled?: boolean;
  expanded?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  onClick: () => void;
}): JSX.Element {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        variant="ghost"
        icon={props.icon}
        label={props.label}
        aria-disabled={props.disabled ? "true" : undefined}
        aria-expanded={props.expanded === undefined ? undefined : props.expanded ? "true" : "false"}
        aria-keyshortcuts={props.keys && shortcutName(props.keys)}
        onClick={() => {
          if (!props.disabled) props.onClick();
        }}
      />
      <Tooltip.Content side={props.side ?? "bottom"} sideOffset={4}>
        <TipText label={props.label} keys={props.keys} />
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

export function TipText(props: { label: string; keys?: string }): JSX.Element {
  return (
    <span class="flex items-center gap-2">
      {props.label}
      {props.keys && <Kbd keys={props.keys} />}
    </span>
  );
}
