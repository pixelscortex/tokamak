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

test("a chat-only hub streams the reply from the member's local machine", async ({
  page,
  request,
  browser,
}) => {
  const hub = "http://127.0.0.1:43124";
  const token = process.env.TOKAMAK_E2E_HOSTED_TOKEN!;
  const local = `http://127.0.0.1:43123/machine/hubs?token=${process.env.VITE_TOKAMAK_TOKEN}`;
  // Browser builds do not bootstrap machines. The sealed test plays the desktop
  // startup operation explicitly; the two windows still talk directly to the hub.
  const activated = await request.post(local, {
    headers: { "content-type": "text/plain" },
    data: JSON.stringify([{ url: hub, token }]),
  });
  expect(activated.ok()).toBe(true);
  const saved = (access: string) =>
    JSON.stringify({ servers: [{ id: "hub", name: "Hub", address: hub, token: access }], selected: "hub" });
  await page.addInitScript((value) => localStorage.setItem("tokamak.servers", value), saved(token));
  let viewer: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    await page.goto("/p/chat");
    const input = page.getByRole("textbox", { name: "Message" });
    await expect(input).toBeEnabled();
    await page.getByRole("button", { name: /New chat/ }).click();
    await expect(input).toBeEnabled();
    const prompt = `Machine link workspace ${crypto.randomUUID().slice(0, 8)}`;
    await input.fill(prompt);
    await input.press("Enter");
    await expect(
      page.getByRole("log", { name: "Conversation" }).getByText(prompt, { exact: true }),
    ).toBeVisible();
    const invited = await request.post(`${hub}/members`, {
      headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
      data: JSON.stringify({ name: "Viewer" }),
    });
    expect(invited.ok()).toBe(true);
    const member = (await invited.json()) as { token: string };
    viewer = await browser.newContext();
    await viewer.addInitScript(
      (value) => localStorage.setItem("tokamak.servers", value),
      saved(member.token),
    );
    const other = await viewer.newPage();
    await other.goto(`${new URL(page.url()).origin}/p/chat`);
    await expect(
      other.getByRole("log", { name: "Conversation" }).getByText(prompt, { exact: true }),
    ).toBeVisible();
    const reply = /Tokamak workspace: a Rust server runs TypeScript plugins/;
    await expect(page.getByRole("log", { name: "Conversation" }).getByText(reply)).toBeVisible();
    await expect(other.getByRole("log", { name: "Conversation" }).getByText(reply)).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  } finally {
    await viewer?.close();
    await request.post(local, { headers: { "content-type": "text/plain" }, data: "[]" });
  }
});
