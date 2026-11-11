/** Compositions over the native elements. Surface and Shell are used by the
 * lab only for now; the app's shell frame and plugin slots are separate. */
export { Sheet, Surface, materials, shellGroups } from "./surface";
export type { Material, PlatePainter, ShapeProps, SheetProps, ShellLayer, SurfaceProps } from "./surface";
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
