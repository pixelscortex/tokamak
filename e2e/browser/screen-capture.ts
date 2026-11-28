import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { screenTree } from "./screen-tree";

export const out = process.env.TOKAMAK_SCREENS;

// Each screenshot also writes the drawn tree (screen-tree.ts) for the Paper copy of the app.
export async function shot(page: Page, name: string) {
  // Menus and dialogs fade in: wait for every animation that ends (spinners never do).
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
  // The tree first, then the picture straight after, so both show the same moment.
  const tree = await screenTree(page);
  await page.screenshot({ path: join(out!, `${name}.png`) });
  await writeFile(join(out!, `${name}.json`), JSON.stringify(tree));
}
export const screen = {
  viewport: { width: 1728, height: 1117 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
} as const;
