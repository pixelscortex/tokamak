/*
  <Kbd keys="mod+n" />   → ⌘N on macOS, Ctrl+N elsewhere

  A keyboard shortcut in data mono, tertiary, with no box.
*/
import type { JSX } from "@solidjs/web";
import { cn } from "./cn.ts";

const apple = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const glyphs: Record<string, [string, string]> = {
  mod: ["⌘", "Ctrl"],
  shift: ["⇧", "Shift"],
  alt: ["⌥", "Alt"],
  ctrl: ["⌃", "Ctrl"],
  enter: ["↩", "Enter"],
  esc: ["esc", "Esc"],
};

export function formatKeys(keys: string, mac = apple): string {
  const parts = keys.split("+").map((key) => {
    const glyph = glyphs[key.toLowerCase()];
    return glyph ? glyph[mac ? 0 : 1] : key.length === 1 ? key.toUpperCase() : key;
  });
  return parts.join(mac ? "" : "+");
}

export function Kbd(props: { keys: string; class?: string }): JSX.Element {
  return (
    <kbd data-slot="kbd" class={cn("text-data whitespace-nowrap text-ink-3", props.class)}>
      {formatKeys(props.keys)}
    </kbd>
  );
}
