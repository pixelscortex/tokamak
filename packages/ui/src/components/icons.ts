/** Icon paths the components draw themselves (24 px viewBox, stroked).
 * From Lucide, ISC licence (https://lucide.dev/license); circles written as
 * equivalent paths. Internal: views bring their own icons. */
export const icons = {
  check: "M20 6 9 17l-5-5",
  chevronDown: "m6 9 6 6 6-6",
  x: "M18 6 6 18 M6 6l12 12",
  search: "M19 11a8 8 0 1 1-16 0a8 8 0 1 1 16 0Z m2 10-4.3-4.3",
  arrowUp: "m5 12 7-7 7 7 M12 19V5",
  paperclip:
    "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48",
  atSign: "M16 12a4 4 0 1 1-8 0a4 4 0 1 1 8 0Z M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8",
  command: "M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3",
  shield:
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
  corner: "M9 10 4 15l5 5 M20 4v7a4 4 0 0 1-4 4H4",
} as const;
