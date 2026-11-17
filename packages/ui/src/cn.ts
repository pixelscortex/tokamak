import {
  clsx,
  createTV,
  extendTailwindMerge,
  type ClassValue,
  type TWMergeConfig,
} from "tailwind-variants/config";

const colors = [
  "window",
  "stage",
  "tray",
  "card",
  "band",
  "ink",
  "ink-2",
  "ink-3",
  "added",
  "removed",
  "warn",
  "info",
  "added-tint",
  "removed-tint",
  "warn-tint",
  "info-tint",
  "brand",
  "brand-ink",
  "brand-tint",
  "edge",
  "edge-strong",
  "lip",
  "highlight",
  "hover",
  "selected",
];

// Teaches merging our scales and helpers, so cn("px-3", "px-row") keeps px-row.
export const twMergeConfig = {
  extend: {
    theme: {
      color: colors,
      text: ["read", "row", "label", "data"],
      radius: ["xs", "sm", "md", "lg", "inner"],
      spacing: ["0", "1", "2", "3", "4", "6", "8", "12", "16"],
      shadow: ["raised", "quiet"],
      "inset-shadow": ["highlight"],
      container: ["read", "dialog", "menu"],
    },
    classGroups: {
      h: ["h-row"],
      px: ["px-row"],
      py: ["py-line"],
      density: ["density-roomy", "density-normal", "density-dense"],
      surface: ["surface-window", "surface-stage", "surface-tray", "surface-card", "surface-band"],
      nest: [{ nest: ["xs", "sm", "md", "lg"] }],
      key: ["lip", "highlight"],
      "focus-ring": ["focus-ring"],
      "text-trim": ["text-trim"],
      link: ["link"],
    },
  },
} satisfies TWMergeConfig;

const merge = extendTailwindMerge(twMergeConfig);

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}

export const tv = createTV({ twMergeConfig });
