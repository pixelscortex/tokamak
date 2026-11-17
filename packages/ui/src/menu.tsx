/*
  <Menu.Root onAction={run}>
    <Menu.Trigger variant="ghost" icon={icons.more} label="Thread actions" />
    <Menu.Content>
      <Menu.Item value="archive" shortcut="mod+e">Archive</Menu.Item>
      <Menu.Separator />
      <Menu.Item value="delete" destructive>Delete</Menu.Item>
    </Menu.Content>
  </Menu.Root>

  A card with 4 padding and radius 12; items are 32 rows with radius 8.
  The trigger takes the Button look props.
*/
import * as Base from "@ui-sdk/solid/menu";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { ButtonContent, buttonClass, lookKeys, type ButtonLook } from "./button.tsx";
import { cn } from "./cn.ts";

type Classed<T extends (props: any) => JSX.Element> = Omit<ComponentProps<T>, "class"> & { class?: string };

export const popupClass =
  "m-0 flex min-w-menu flex-col rounded-md border-0 surface-card p-1 inset-ring inset-ring-edge outline-none";
export const itemClass = [
  "flex h-8 cursor-default items-center gap-2 rounded-sm px-2 text-row text-ink outline-none select-none",
  "data-highlighted:bg-hover data-disabled:text-ink-3",
];

export const Root = Base.Menu;

export function Trigger(
  props: Omit<ComponentProps<typeof Base.MenuTrigger>, "children" | "class"> & ButtonLook,
) {
  const rest = omit(props, ...lookKeys);
  return (
    <Base.MenuTrigger {...rest} class={buttonClass(props)} aria-label={props.label}>
      <ButtonContent {...props} />
    </Base.MenuTrigger>
  );
}

export function Content(props: Classed<typeof Base.MenuContent>) {
  return <Base.MenuContent {...omit(props, "class")} class={cn(popupClass, props.class)} />;
}

export function Item(props: Classed<typeof Base.MenuItem>) {
  return (
    <Base.MenuItem
      {...omit(props, "class")}
      class={cn(
        itemClass,
        "data-destructive:text-removed *:data-[slot=menu-shortcut]:ms-auto *:data-[slot=menu-shortcut]:ps-4",
        "*:data-[slot=menu-shortcut]:text-data *:data-[slot=menu-shortcut]:text-ink-3",
        props.class,
      )}
    />
  );
}

export function Separator(props: Classed<typeof Base.MenuSeparator>) {
  return (
    <Base.MenuSeparator
      {...omit(props, "class")}
      class={cn("-mx-1 my-1 h-px border-0 bg-edge", props.class)}
    />
  );
}

export function GroupLabel(props: Classed<typeof Base.MenuGroupLabel>) {
  return (
    <Base.MenuGroupLabel
      {...omit(props, "class")}
      class={cn("flex h-6 items-center px-2 text-label text-ink-3", props.class)}
    />
  );
}

export const Group = Base.MenuGroup;
