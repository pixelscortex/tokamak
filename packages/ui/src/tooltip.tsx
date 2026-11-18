/*
  <Tooltip.Root>
    <Tooltip.Trigger variant="ghost" icon={icons.search} label="Search" />
    <Tooltip.Content>Search threads</Tooltip.Content>
  </Tooltip.Root>

  Plain text, 12/16 on the band tone. Status words live here.
*/
import * as Base from "@ui-sdk/solid/tooltip";
import { omit } from "solid-js";
import type { ComponentProps } from "@solidjs/web";
import { ButtonContent, buttonClass, lookKeys, type ButtonLook } from "./button.tsx";
import { cn } from "./cn.ts";

export const Root = Base.Tooltip;

export function Trigger(
  props: Omit<ComponentProps<typeof Base.TooltipTrigger>, "children" | "class"> & ButtonLook,
) {
  const rest = omit(props, ...lookKeys);
  return (
    <Base.TooltipTrigger {...rest} class={buttonClass(props)} aria-label={props.label}>
      <ButtonContent {...props} />
    </Base.TooltipTrigger>
  );
}

export function Content(
  props: Omit<ComponentProps<typeof Base.TooltipContent>, "class"> & { class?: string },
) {
  return (
    <Base.TooltipContent
      {...omit(props, "class")}
      class={cn(
        "m-0 rounded-sm border-0 bg-band px-2 py-1 text-label text-ink inset-ring inset-ring-edge",
        props.class,
      )}
    />
  );
}
