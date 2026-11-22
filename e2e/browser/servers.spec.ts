import { test, expect, type Page } from "@playwright/test";

// The second server is e2e/serve-hosted.ts: hosted mode on 127.0.0.1:43124 with its own token.
const footer = (page: Page) => page.getByRole("status", { name: "Connection status" });
const flow = (page: Page) => page.getByRole("region", { name: "Add a server" });

test("add a server, switch to it, chat there and remove it", async ({ page }) => {
  await page.goto("/p/integration-fixture");
  await expect(footer(page)).toHaveText("127.0.0.1:43123");

  await page.getByRole("button", { name: /^Server: This Mac/ }).click();
  await page.getByRole("menuitem", { name: "Add server…" }).click();
  await expect(page.getByRole("heading", { name: "Join a server" })).toBeVisible();
  await page.getByRole("textbox", { name: "Server address" }).fill("127.0.0.1:43124");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(flow(page).getByText("Found the server")).toBeVisible();
  await flow(page).getByRole("button", { name: "Continue" }).click();

  await page.getByRole("button", { name: "Use an invite" }).click();
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
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("link", { name: "Chat", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "Message" });
  const text = `A message on the shared server ${crypto.randomUUID().slice(0, 8)}`;
  await editor.fill(text);
  await editor.press("Enter");
  await expect(
    page.getByRole("log", { name: "Conversation" }).getByText(text, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Server: 127\.0\.0\.1:43124/ }).click();
  await page.getByRole("menuitem", { name: "Remove this server" }).click();
  await expect(footer(page)).toHaveText("127.0.0.1:43123");
});

test("a hosted browser writes messages without a local part", async ({ page }) => {
  await page.addInitScript(
    (token) => localStorage.setItem("tokamak.access-token", token),
    process.env.TOKAMAK_E2E_HOSTED_TOKEN!,
  );
  await page.goto("http://127.0.0.1:43124/p/chat");
  await expect(footer(page)).toHaveText("127.0.0.1:43124");
  await page
    .getByRole("navigation", { name: "Chat threads" })
    .getByRole("button", { name: /New thread/ })
    .click();
  await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
  const editor = page.getByRole("textbox", { name: "Message" });
  const text = "A message from the hosted browser";
  await editor.fill(text);
  await editor.press("Enter");
  await expect(
    page.getByRole("log", { name: "Conversation" }).getByText(text, { exact: true }),
  ).toBeVisible();
});
