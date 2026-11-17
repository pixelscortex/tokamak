/*
  <Collapsible.Root>
    <Collapsible.Trigger lead={<StatusIcon status="done" />} trail="12s">
      Worked <span class="text-label text-ink-3">4 actions</span>
    </Collapsible.Trigger>
    <Collapsible.Panel>…</Collapsible.Panel>
  </Collapsible.Root>

  One row that opens a panel under it. The trigger is a 32 px row with radius
  8: a 16 lead, the summary, one quiet trail and a chevron that turns when
  open. filled sits on the surface's hover tone; quiet is bare until hover.
*/
import * as Base from "@ui-sdk/solid/collapsible";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { cn, tv } from "./cn.ts";
import { Icon } from "./icon.tsx";
import { icons } from "./icons.ts";

type Classed<T extends (props: any) => JSX.Element> = Omit<ComponentProps<T>, "class"> & { class?: string };

export const triggerVariants = tv({
  slots: {
    root: [
      "group/trigger flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-sm ps-2 pe-3",
      "text-row text-ink-2 transition duration-200 focus-ring data-disabled:cursor-default",
    ],
    lead: "flex w-4 shrink-0 justify-center text-ink-3",
    title: "flex min-w-0 flex-1 items-center gap-2 truncate",
    trail: "shrink-0 text-data text-ink-3",
  },
  variants: {
    variant: {
      filled: { root: "bg-hover hover:bg-selected" },
      quiet: { root: "hover:bg-hover" },
    },
  },
  defaultVariants: { variant: "filled" },
});

export const Root = Base.Collapsible;

export function Trigger(
  props: Omit<ComponentProps<typeof Base.CollapsibleTrigger>, "class" | "children"> & {
    variant?: "filled" | "quiet";
    lead?: JSX.Element;
    trail?: JSX.Element;
    class?: string;
    children: JSX.Element;
  },
): JSX.Element {
  const rest = omit(props, "variant", "lead", "trail", "class", "children");
  const slots = () => triggerVariants({ variant: props.variant });
  return (
    <Base.CollapsibleTrigger {...rest} class={cn(slots().root(), props.class)}>
      {props.lead && <span class={slots().lead()}>{props.lead}</span>}
      <span class={slots().title()}>{props.children}</span>
      {props.trail && <span class={slots().trail()}>{props.trail}</span>}
      <span class="flex text-ink-3 transition duration-200 group-data-open/trigger:rotate-180">
        <Icon path={icons.chevronDown} size={12} />
      </span>
    </Base.CollapsibleTrigger>
  );
}

export function Panel(props: Classed<typeof Base.CollapsiblePanel>): JSX.Element {
  return (
    <Base.CollapsiblePanel
      {...omit(props, "class")}
      class={cn(
        "transition duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0",
        props.class,
      )}
    />
  );
}
