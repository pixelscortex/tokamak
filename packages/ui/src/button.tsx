/*
  <Button variant="brand" onClick={merge}>Merge</Button>
  <Button>Cancel</Button>
  <Button variant="ghost" icon={icons.more} label="Thread actions" />

  Variants: brand (purple) or primary (ink), at most one of the two per
  region; secondary (default, a neutral key); outline (surface fill, thin
  edge); destructive (red, only on the button that deletes); ghost (no fill,
  no depth, for icon buttons and quiet actions). Sizes: md 32, lg 40.
  Radius is 8 (rounded-sm); in a padded container the container's radius
  is 8 + its padding.
  An icon-only button needs a label: it becomes the accessible name.
  A consumer may add layout classes only (margin, width, flex, grid placement).
  Slots: an optional 16 px icon before the text. data-slot="button",
  data-button="<variant>", data-size, data-icon-only.
*/
import { Button as UiButton } from "@ui-sdk/solid/button";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { Icon } from "./icon.tsx";

export type ButtonVariant = "brand" | "primary" | "secondary" | "outline" | "destructive" | "ghost";
export type ButtonSize = "md" | "lg";

export type ButtonLook = {
  variant?: ButtonVariant;
  size?: ButtonSize;
} & (
  | { icon?: string; label?: undefined; children: JSX.Element }
  | { icon: string; label: string; children?: undefined }
);

export const lookKeys = ["variant", "size", "icon", "label", "children"] as const;

export function lookAttributes(props: ButtonLook) {
  return {
    "data-button": props.variant ?? "secondary",
    "data-size": props.size ?? "md",
    "data-icon-only": props.label === undefined ? undefined : "",
    "aria-label": props.label,
  };
}

export function LookContent(props: ButtonLook): JSX.Element {
  return (
    <>
      {props.icon && <Icon path={props.icon} />}
      {props.children}
    </>
  );
}

export type ButtonProps = Omit<ComponentProps<typeof UiButton>, "children"> & ButtonLook;

export function Button(props: ButtonProps): JSX.Element {
  const rest = omit(props, ...lookKeys);
  return (
    <UiButton {...rest} {...lookAttributes(props)}>
      <LookContent {...props} />
    </UiButton>
  );
}
