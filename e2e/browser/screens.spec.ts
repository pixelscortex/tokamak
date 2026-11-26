import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { startHostedFixture } from "../hosted-fixture";
import { out, screen, shot } from "./screen-capture";

test.skip(!out, "set TOKAMAK_SCREENS to a folder to take the screenshots");

test("shell screens", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext(screen);
  try {
    const page = await context.newPage();
    await page.goto("/welcome");
    await expect(page.getByRole("region", { name: "Welcome" })).toBeVisible();
    await shot(page, "shell-welcome");
    await page.goto("/connect");
    await expect(page.getByRole("textbox", { name: "Server address" })).toBeVisible();
    await shot(page, "shell-connect");
    await page.goto("/settings/members");
    await expect(page.getByText("Members are managed on a shared server.")).toBeVisible();
    await shot(page, "shell-members-this-mac");
    await page.goto("/p/integration-fixture");
    await expect(page.getByRole("region", { name: "Integration fixture" })).toBeVisible();
    await page.getByRole("button", { name: /^Server: / }).click();
    await shot(page, "shell-server-menu");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await shot(page, "shell-settings-menu");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "shell-search");
    await page.keyboard.press("Escape");
  } finally {
    await context.close();
  }

  // A shared server: the sign-in dialog, then Members and Devices once signed in.
  const ownerKey = randomBytes(32).toString("hex");
  const shared = await startHostedFixture({ port: 0, ownerKey });
  const hosted = await browser.newContext(screen);
  try {
    const page = await hosted.newPage();
    await page.goto(new URL("/p/integration-fixture", shared.url).href);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Username or email")).toBeVisible();
    await shot(page, "shell-sign-in");
    await dialog.getByRole("button", { name: "Set up owner account" }).click();
    await dialog.getByLabel("Owner key").fill(ownerKey);
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog.getByLabel("Username", { exact: true }).fill("sam");
    await dialog.getByLabel("Email", { exact: true }).fill("sam@example.com");
    await dialog.getByLabel("Password", { exact: true }).fill("password for the screens");
    await dialog.getByRole("button", { name: "Create account" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("menuitem", { name: "Members" }).click();
    await expect(page.getByRole("region", { name: "Members" }).getByRole("listitem").first()).toBeVisible();
    await shot(page, "shell-members");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("menuitem", { name: "Devices" }).click();
    await expect(page.getByRole("region", { name: "Devices" })).toBeVisible();
    await shot(page, "shell-devices");
  } finally {
    await hosted.close();
    shared.stop();
    await shared.exited;
  }
});
