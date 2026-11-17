/*
  <Tooltip>
    <TooltipTrigger variant="ghost" icon={icons.search} label="Search" />
    <TooltipContent>Search threads</TooltipContent>
  </Tooltip>

  ui-sdk Tooltip. Plain text only, 12/16 on the band tone, radius 8. The
  trigger takes the Button look props. Status words live here: a status
  icon's tooltip says "Fix total rounding, needs you".
  Slots: tooltip-trigger, tooltip-content.
*/
import { TooltipTrigger as UiTooltipTrigger } from "@ui-sdk/solid/tooltip";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { LookContent, lookAttributes, lookKeys, type ButtonLook } from "./button.tsx";

export { Tooltip, TooltipContent } from "@ui-sdk/solid/tooltip";

export type TooltipTriggerProps = Omit<ComponentProps<typeof UiTooltipTrigger>, "children"> & ButtonLook;

export function TooltipTrigger(props: TooltipTriggerProps): JSX.Element {
  const rest = omit(props, ...lookKeys);
  return (
    <UiTooltipTrigger {...rest} {...lookAttributes(props)}>
      <LookContent {...props} />
    </UiTooltipTrigger>
  );
}
