/** Buttons change fill on hover and press; focus uses a ring.
 * <Button variant="primary" onClick={run}>Run</Button>
 * <Button variant="ghost" size="icon" label="Attach">…</Button>
 */
import { splitProps } from "solid-js";
import type { JSX } from "@tokamak/render";

export type ButtonVariant = "primary" | "neutral" | "outline" | "destructive" | "ghost";
export type ButtonSize = "sm" | "md" | "icon";

export interface ButtonProps extends Omit<JSX.ButtonAttributes, "type"> {
  /** `neutral` by default. */
  variant?: ButtonVariant;
  /** `md` (30 px) by default; `sm` is 26 px; `icon` a 28 px square. */
  size?: ButtonSize;
  /** A toggle: present means it toggles, true holds it down
   * (`aria-pressed`). The owner flips it in `onClick`. */
  pressed?: boolean;
  /** Fully rounded ends (a round icon button, a pill). */
  round?: boolean;
  /** Accessible name, for icon buttons without text. */
  label?: string;
}

export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "variant",
    "size",
    "pressed",
    "round",
    "label",
    "class",
    "disabled",
  ]);
  const variant = () => local.variant ?? "neutral";
  const size = () => local.size ?? "md";
  return (
    <button
      {...rest}
      type="button"
      aria-label={local.label ?? rest["aria-label"]}
      aria-pressed={local.pressed}
      aria-disabled={local.disabled ? true : undefined}
      disabled={local.disabled}
      data-variant={variant()}
      class={`inline-flex shrink-0 items-center justify-center gap-1.5 border-0 font-ui font-medium whitespace-nowrap outline-none focus:ring-2 focus:ring-ink-5 aria-disabled:opacity-40 ${
        variant() === "ghost"
          ? "bg-transparent text-ink-3 not-aria-disabled:hover:bg-chip not-aria-disabled:hover:text-ink not-aria-disabled:active:bg-card aria-pressed:bg-chip aria-pressed:text-ink"
          : variant() === "primary"
            ? "bg-ink text-base not-aria-disabled:hover:bg-white not-aria-disabled:active:bg-ink-body aria-pressed:bg-ink-body"
            : variant() === "outline"
              ? "bg-well text-ink-body not-aria-disabled:hover:bg-card not-aria-disabled:hover:text-ink not-aria-disabled:active:bg-base aria-pressed:bg-card"
              : `bg-chip not-aria-disabled:hover:bg-lift not-aria-disabled:active:bg-card aria-pressed:bg-card ${
                  variant() === "destructive" ? "text-danger" : "text-ink"
                }`
      } ${
        size() === "icon"
          ? "size-7 p-0"
          : size() === "sm"
            ? "h-[26px] px-2.5 text-[12px] leading-4"
            : "h-[30px] px-3 text-[13px] leading-4"
      } ${local.round ? "rounded-full" : size() === "md" ? "rounded-md" : "rounded-sm"} ${local.class ?? ""}`}
    />
  );
}
