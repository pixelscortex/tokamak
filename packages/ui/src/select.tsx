/*
  <Select.Root defaultValue="normal" items={densities}>
    <Select.Label>Density</Select.Label>
    <Select.Trigger><Select.Value /></Select.Trigger>
    <Select.Content>
      <Select.Item value="normal">Normal</Select.Item>
    </Select.Content>
  </Select.Root>

  The trigger is an outline key with a chevron; the list is the Menu card,
  and the chosen item carries a check.
*/
import * as Base from "@ui-sdk/solid/select";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { buttonVariants } from "./button.tsx";
import { cn } from "./cn.ts";
import { Icon } from "./icon.tsx";
import { icons } from "./icons.ts";
import { itemClass, popupClass } from "./menu.tsx";

type Classed<T extends (props: any) => JSX.Element> = Omit<ComponentProps<T>, "class"> & { class?: string };

export const Root = Base.Select;

export function Label(props: Classed<typeof Base.SelectLabel>) {
  return (
    <Base.SelectLabel {...omit(props, "class")} class={cn("mb-2 block text-label text-ink-2", props.class)} />
  );
}

export function Trigger(props: Classed<typeof Base.SelectTrigger>) {
  return (
    <Base.SelectTrigger
      {...omit(props, "class", "children")}
      class={cn(
        buttonVariants({ variant: "outline" }),
        "min-w-menu justify-between pe-2 font-normal",
        props.class,
      )}
    >
      {props.children}
      <Icon path={icons.chevronDown} class="text-ink-3" />
    </Base.SelectTrigger>
  );
}

export function Value(props: Classed<typeof Base.SelectValue>) {
  return (
    <Base.SelectValue {...omit(props, "class")} class={cn("data-placeholder:text-ink-3", props.class)} />
  );
}

export function Content(props: Classed<typeof Base.SelectContent>) {
  return <Base.SelectContent {...omit(props, "class")} class={cn(popupClass, props.class)} />;
}

export function Item(props: Classed<typeof Base.SelectItem>) {
  return (
    <Base.SelectItem {...omit(props, "class", "children")} class={cn(itemClass, "gap-4", props.class)}>
      {props.children}
      <Base.SelectItemIndicator class="ms-auto">
        <Icon path={icons.check} />
      </Base.SelectItemIndicator>
    </Base.SelectItem>
  );
}
