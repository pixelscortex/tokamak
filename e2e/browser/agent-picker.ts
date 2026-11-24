import { expect, type Page } from "@playwright/test";

export async function pickAgentOption(page: Page, picker: "Agent" | "Model", option: string) {
  const name = new RegExp(`^${picker}:`);
  const trigger = page.getByRole("group", { name: "Agent" }).getByRole("button", { name });
  await trigger.click();
  const menu = page.getByRole("menu", { name });
  // Opening the picker refreshes its options and can replace rows during the entrance.
  await expect(menu).toHaveCSS("opacity", "1");
  const item = menu.getByRole("menuitem", { name: option, exact: true });
  await item.scrollIntoViewIfNeeded();
  await expect(item).toBeInViewport();
  await item.click();
  // Let this selection close its own menu before clicking the next trigger.
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("menu", { name, includeHidden: true })).toBeHidden();
}
