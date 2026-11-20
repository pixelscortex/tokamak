import { test, expect, type Page } from "@playwright/test";

// The real server runs chat and ACP; ACP finds only the scripted agent from
// e2e/fixtures/scripted-agent.py, so replies, tool steps and permissions are real
// protocol traffic with no model behind them.

test.beforeEach(async ({ page, browserName }) => {
  const rate = Number(process.env.TOKAMAK_E2E_CPU_RATE ?? 1);
  if (browserName === "chromium" && rate > 1) {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate });
  }
});

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

test("creating a thread disables the old composer until the new thread is selected", async ({ page }) => {
  let hold = false;
  let createId: number | undefined;
  let release: (() => void) | undefined;
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const request = JSON.parse(String(message));
      if (hold && request.type === "action" && request.name === "chat/threads:create") createId = request.id;
      server.send(message);
    });
    server.onMessage((message) => {
      const event = JSON.parse(String(message));
      if (event.type === "response" && event.id === createId) {
        release = () => socket.send(message);
      } else socket.send(message);
    });
  });
  await openChat(page);
  await newThread(page);
  const input = page.getByRole("textbox", { name: "Message" });
  await input.fill("Keep this draft in the previous thread");
  const threads = page.getByRole("listbox", { name: "Threads" }).getByRole("option");
  const before = await threads.count();
  const current = page.getByRole("region", { name: "Chat", exact: true });
  const previousId = await current.getAttribute("data-thread-id");
  hold = true;
  await page.getByRole("button", { name: /New chat/ }).click();
  await expect(threads).toHaveCount(before + 1);
  await expect.poll(() => Boolean(release)).toBe(true);
  await expect(input).toBeDisabled();
  release!();
  await expect(input).toBeEnabled();
  await expect(current).not.toHaveAttribute("data-thread-id", previousId!);
  await expect(input).toHaveValue("");
  await send(page, "Send to the newly selected thread");
});

test("switching the thread agent keeps each earlier reply labelled with the agent that wrote it", async ({
  page,
}) => {
  await openChat(page);
  await newThread(page);
  const log = page.getByRole("log", { name: "Conversation" });
  // Every turn is an article named after its author: "You", or the reply's agent.
  const turns = log.getByRole("article");
  await send(page, "Answer as the first agent");
  await expect(turns).toHaveCount(2);
  await expect(turns.nth(1)).toHaveAccessibleName("Claude");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  await page.getByRole("button", { name: /^Claude(?:\s|$)/ }).click();
  await page.getByRole("menuitem", { name: "Codex", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Codex(?:\s|$)/ })).toBeVisible();
  // Switching alone must not relabel the reply Claude already wrote.
  await expect(turns.nth(1)).toHaveAccessibleName("Claude");

  await send(page, "Answer as the second agent");
  await expect(turns).toHaveCount(4);
  await expect(turns.nth(3)).toHaveAccessibleName("Codex");
  await expect(turns.nth(3).getByText(/Tokamak workspace/)).toBeVisible();
  await expect(turns.nth(1)).toHaveAccessibleName("Claude");
});

test("a server on another release line allows messages but cannot start an agent turn", async ({ page }) => {
  await page.route("**/version", (route) => route.fulfill({ json: { version: "999.0.0" } }));
  const agentActions: string[] = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      const request = JSON.parse(String(payload));
      if (request.type === "action" && /^(chat\/chat:send|acp\/relay:relayTurn)$/.test(request.name))
        agentActions.push(request.name);
    }),
  );
  await openChat(page);
  await expect(page.getByRole("alert").getByText("Update the app", { exact: true })).toBeVisible();
  await newThread(page);
  await expect(page.getByRole("button", { name: "Message only", exact: true })).toHaveCount(0);
  await send(page, "A message without an agent");
  expect(agentActions).toEqual([]);
});
