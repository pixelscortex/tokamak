import { test, expect, type Page } from "@playwright/test";

// The second server is e2e/serve-hosted.ts: hosted mode on 127.0.0.1:43124 with its own token.
const footer = (page: Page) => page.getByRole("status", { name: "Connection status" });
const flow = (page: Page) => page.getByRole("region", { name: "Add a server" });

test("add a hosted server, switch to it and back, and keep the choice", async ({ page }) => {
  await page.goto("/p/integration-fixture");
  await expect(footer(page)).toHaveText("127.0.0.1:43123");

  await page.getByRole("button", { name: /^Server: This Mac/ }).click();
  await page.getByRole("menuitem", { name: "Add server…" }).click();
  await expect(page.getByRole("heading", { name: "Join a server" })).toBeVisible();
  await page.getByRole("textbox", { name: "Server address" }).fill("127.0.0.1:43124");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(flow(page).getByText("Found the server")).toBeVisible();
  await flow(page).getByRole("button", { name: "Continue" }).click();

  const token = page.getByRole("textbox", { name: "Invite token" });
  await token.fill("not-the-token");
  await page.getByRole("button", { name: "Join" }).click();
  await expect(flow(page).getByRole("alert")).toContainText("This invite wasn't accepted");
  await token.fill(process.env.TOKAMAK_E2E_HOSTED_TOKEN!);
  await page.getByRole("button", { name: "Join" }).click();
  await page.getByRole("textbox", { name: "Your name" }).fill("Noor");
  await page.getByRole("button", { name: "Open 127.0.0.1:43124" }).click();

  await expect(footer(page)).toHaveText("127.0.0.1:43124");
  await expect(
    page.getByRole("navigation", { name: "Open pages" }).getByRole("button", { name: "Add a server" }),
  ).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+1");
  await expect(footer(page)).toHaveText("127.0.0.1:43123");
  await page.keyboard.press("ControlOrMeta+2");
  await expect(footer(page)).toHaveText("127.0.0.1:43124");

  await page.reload();
  await expect(footer(page)).toHaveText("127.0.0.1:43124");
  await page.getByRole("button", { name: /^Server: 127\.0\.0\.1:43124/ }).click();
  await expect(page.getByRole("menuitem", { name: "This Mac, answering" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Remove this server" }).click();
  await expect(footer(page)).toHaveText("127.0.0.1:43123");
});
