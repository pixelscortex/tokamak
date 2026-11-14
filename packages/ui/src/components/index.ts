/** Compositions over the native elements. Surface and Shell are used by the
 * lab only for now; the app's shell frame and plugin slots are separate. */
export { Surface } from "./surface";
export type { AddProps, ShapeProps, ShellLayer, SurfaceProps } from "./surface";
export { Shell, rail, railItemTop, topBar } from "./shell";
export type { ShellProps } from "./shell";
/** Plate controls (Tailwind utilities and theme tokens only). `Button` here
 * is the plate button; `@tokamak/ui/elements` keeps the older class-based
 * one for existing plugins. */
export { Button } from "./button";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./button";
export { Kbd } from "./kbd";
export type { KbdProps } from "./kbd";
export { Chip, ChipMore } from "./chip";
export type { ChipMoreProps, ChipProps } from "./chip";
export { Textarea, textareaLine } from "./textarea";
export type { TextareaProps } from "./textarea";
export { Select } from "./select";
export type { SelectOption, SelectProps } from "./select";
export { Composer } from "./composer";
export type {
  ComposerApproval,
  ComposerCommand,
  ComposerContext,
  ComposerField,
  ComposerForm,
  ComposerProps,
  ComposerRun,
} from "./composer";
export { dismissOutside } from "./dismiss";
/** Floating pieces: where a menu, popover or tooltip opens (place.ts). */
export { place, trackLayout } from "./floating";
export type { Box, Layout, PlaceOptions, Placement, Side } from "./floating";
