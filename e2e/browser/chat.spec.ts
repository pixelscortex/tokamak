import { test, expect, type Page } from "@playwright/test";

// The real server runs chat and ACP; ACP finds only the scripted agent from
// e2e/fixtures/scripted-agent.py, so replies, tool steps and permissions are real
// protocol traffic with no model behind them.

async function openChat(page: Page) {
  // Chat is the first view in the catalog, so opening the app lands on it.
  await page.goto("/");
  await expect(page).toHaveURL(/\/p\/chat$/);
  await expect(
    page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Chat", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("complementary", { name: "Sidebar" }).getByRole("navigation", { name: "Chat threads" }),
  ).toBeVisible();
}

async function newThread(page: Page) {
  const threads = page.getByRole("listbox", { name: "Threads" }).getByRole("option");
  // On an empty store chat opens its own first thread; count after it exists.
  await expect(threads.first()).toBeVisible();
  const before = await threads.count();
  await page.getByRole("button", { name: /New chat/ }).click();
  await expect(threads).toHaveCount(before + 1);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
}

async function send(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "Message" });
  await input.fill(text);
  await input.press("Enter");
  await expect(
    page.getByRole("log", { name: "Conversation" }).getByText(text, { exact: true }),
  ).toBeVisible();
}

test("a thread is created, answered with folded tool work, and listed", async ({ page }) => {
  await openChat(page);
  await newThread(page);
  const prompt = `Explain how this project is laid out ${crypto.randomUUID().slice(0, 8)}`;
  await send(page, prompt);

  const log = page.getByRole("log", { name: "Conversation" });
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(log.getByText(/Tokamak workspace: a Rust server runs TypeScript plugins/)).toBeVisible();
  const work = log.getByRole("button", { name: /Worked\s*3 actions/ });
  await expect(work).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  await work.click();
  const steps = log.getByRole("list", { name: "Steps" });
  await expect(steps.getByRole("listitem")).toHaveText([
    /Listed the project files/,
    /Searched for refresh\(/,
    /Read README.md/,
  ]);

  const row = page.getByRole("listbox", { name: "Threads" }).getByRole("option", { name: prompt });
  await expect(row).toHaveAttribute("aria-selected", "true");
  const header = page.getByRole("banner", { name: "Page header" });
  await expect(header.getByRole("heading")).toHaveText([prompt]);
  // The shell names the tab and the window after the thread, and shows chat's icon in the rail.
  await expect(
    page.getByRole("navigation", { name: "Open pages" }).getByRole("button", { name: prompt, exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle(`${prompt} · Tokamak`);
  await expect(
    page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Chat" }).locator("svg path"),
  ).toHaveCount(1);
});

test("a permission request asks in one band and the answer reaches the agent", async ({ page }) => {
  await openChat(page);
  await newThread(page);
  await send(page, "Push the branch, ask permission first");

  const band = page.getByRole("region", { name: "Claude needs you" });
  await expect(band).toContainText("git push origin fix/session-refresh");
  await expect(band.getByRole("button", { name: "Deny" })).toBeVisible();
  await band.getByRole("button", { name: "Allow", exact: true }).click();

  await expect(band).toBeHidden();
  const log = page.getByRole("log", { name: "Conversation" });
  await expect(log.getByText(/Pushed\s*fix\/session-refresh/)).toBeVisible();
  await expect(log.getByRole("button", { name: /Worked\s*2 actions/ })).toBeVisible();
});

test("a reply can be stopped, and a follow-up typed meanwhile is queued", async ({ page }) => {
  await openChat(page);
  await newThread(page);
  await send(page, "Make the slow auth test pass");
  const log = page.getByRole("log", { name: "Conversation" });
  await expect(log.getByRole("button", { name: /Running pnpm test auth/ })).toBeVisible();

  const input = page.getByRole("textbox", { name: "Message" });
  await input.fill("Then explain the fix");
  await input.press("Enter");
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(log.getByText("Stopped", { exact: true })).toBeVisible();
  // The queued follow-up goes out once the stopped run settles.
  await expect(log.getByText("Then explain the fix", { exact: true })).toBeVisible();
  await expect(log.getByText(/Tokamak workspace/)).toBeVisible();
});
