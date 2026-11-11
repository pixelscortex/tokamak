/** Button: a plate you press (render/SURFACES.md, "Plates").
 *
 *   <Button variant="primary" onClick={run}>Run</Button>
 *   <Button variant="ghost" size="icon" label="Attach"><Icon d={…} class="size-4" /></Button>
 *   <Button pressed={always()} onClick={() => setAlways(!always())}>Always allow</Button>
 *
 * Every variant but `ghost` stands off the surface (`elevation-3`), sinks a
 * step on hover and all the way while pressed (`active:pressed`); a toggle
 * that is on stays down (`aria-pressed:pressed`). No bevel, no border, no
 * shadow: the plate's strip and faint outline are its edge. `ghost` has no
 * plate until hover. Keyboard focus shows a ring (`:focus`; Blitz has no
 * `:focus-visible`, so a click that focuses shows it too).
 *
 * This is the plate button. `@tokamak/ui/elements` still exports the older
 * class-based `Button` (`.tk-button`), which the todo plugin uses. */
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
  const [local, rest] = splitProps(props, ["variant", "size", "pressed", "round", "label", "class", "disabled"]);
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
          : `elevation-3 not-aria-disabled:hover:sink-1 not-aria-disabled:active:pressed aria-pressed:pressed ${
              variant() === "primary"
                ? "bg-ink text-base"
                : variant() === "outline"
                  ? "bg-well text-ink-body"
                  : variant() === "destructive"
                    ? "bg-chip text-danger"
                    : "bg-chip text-ink"
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
