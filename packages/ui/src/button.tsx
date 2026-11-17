/*
  <Button variant="brand" onClick={merge}>Merge</Button>
  <Button>Cancel</Button>
  <Button variant="ghost" icon={icons.more} label="Thread actions" />

  brand or primary: the one main action in a region. outline: the default.
  destructive: only the button that deletes. ghost: icon buttons and quiet
  actions. An icon-only button needs a label; it becomes its name.
*/
import { Button as Base } from "@ui-sdk/solid/button";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { cn, tv } from "./cn.ts";
import { Icon } from "./icon.tsx";

export const buttonVariants = tv({
  base: [
    "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-sm",
    "text-row font-medium whitespace-nowrap select-none transition duration-200 focus-ring",
    "disabled:cursor-default disabled:opacity-50 data-disabled:cursor-default data-disabled:opacity-50",
    "aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent",
    "data-pending:cursor-progress",
  ],
  variants: {
    variant: {
      brand: "key from-brand to-brand/85 text-brand-ink",
      primary: "key from-ink to-ink/85 text-stage light:hover:brightness-150",
      destructive: "key from-removed to-removed/85 text-stage",
      outline: [
        "border-b-2 border-edge-strong inset-ring inset-ring-edge-strong text-ink shadow-quiet",
        "hover:bg-edge active:bg-edge-strong/45",
      ],
      ghost:
        "text-ink-2 hover:bg-edge hover:text-ink active:bg-edge-strong/45 data-open:bg-edge data-open:text-ink",
    },
    size: { md: "h-8 px-3", lg: "h-12 px-4" },
    iconOnly: { true: "px-0" },
  },
  compoundVariants: [
    { iconOnly: true, size: "md", class: "w-8" },
    { iconOnly: true, size: "lg", class: "w-12" },
    { iconOnly: true, variant: "ghost", class: "text-ink-3" },
  ],
  defaultVariants: { variant: "outline", size: "md" },
});

export type ButtonVariant = "brand" | "primary" | "outline" | "destructive" | "ghost";
export type ButtonSize = "md" | "lg";

export type ButtonLook = { variant?: ButtonVariant; size?: ButtonSize; class?: string } & (
  | { icon?: string; label?: undefined; children: JSX.Element }
  | { icon: string; label: string; children?: undefined }
);

export const lookKeys = ["variant", "size", "icon", "label", "children", "class"] as const;

export function buttonClass(props: ButtonLook): string {
  return cn(
    buttonVariants({ variant: props.variant, size: props.size, iconOnly: props.label !== undefined }),
    props.class,
  );
}

export function ButtonContent(props: ButtonLook): JSX.Element {
  return (
    <>
      {props.icon && <Icon path={props.icon} />}
      {props.children !== undefined && <span class="text-trim">{props.children}</span>}
    </>
  );
}

export type ButtonProps = Omit<ComponentProps<typeof Base>, "children" | "class"> & ButtonLook;

export function Button(props: ButtonProps): JSX.Element {
  const rest = omit(props, ...lookKeys);
  return (
    <Base {...rest} data-slot="button" class={buttonClass(props)} aria-label={props.label}>
      <ButtonContent {...props} />
    </Base>
  );
}
