import { test, expect, type Page } from "@playwright/test";

// The second server is e2e/serve-hosted.ts: hosted mode on 127.0.0.1:43124 with its own token.
const footer = (page: Page) => page.getByRole("status", { name: "Connection status" });
const flow = (page: Page) => page.getByRole("region", { name: "Add a server" });

test("retry a lost local reply on a chat-only hub without starting another turn", async ({ page }) => {
  const requestIds: string[] = [];
  await page.routeWebSocket(
    (url) => url.host === "127.0.0.1:43123",
    (socket) => {
      const server = socket.connectToServer();
      let dropResponse: number | undefined;
      socket.onMessage((payload) => {
        const request = JSON.parse(String(payload));
        if (request.type === "action" && request.name === "acp/relay:relayTurn") {
          requestIds.push(request.args.requestId);
          if (requestIds.length === 1) dropResponse = request.id;
        }
        server.send(payload);
      });
      server.onMessage((payload) => {
        const event = JSON.parse(String(payload));
        if (event.type === "response" && event.id === dropResponse) void socket.close();
        else socket.send(payload);
      });
    },
  );
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
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("link", { name: "Chat", exact: true })
    .click();
  await page.getByRole("button", { name: /New chat/ }).click();
  await page.getByRole("button", { name: "Message only", exact: true }).click();
  await page.getByRole("menuitem", { name: "Claude", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Message" });
  await expect(editor).toHaveAttribute("placeholder", "Ask Claude");
  const prompt = "Describe the workspace from my computer";
  await editor.fill(prompt);
  await editor.press("Enter");
  const conversation = page.getByRole("log", { name: "Conversation" });
  await expect(conversation.getByText(/This is a Tokamak workspace/)).toBeVisible();
  await expect(editor).toHaveValue(prompt);
  await editor.press("Enter");
  await expect(editor).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => requestIds).toEqual([expect.any(String), expect.any(String)]);
  expect(requestIds[0]).toBe(requestIds[1]);
  await expect(conversation.getByText(prompt, { exact: true })).toHaveCount(1);
  await expect(conversation.getByText(/This is a Tokamak workspace/)).toHaveCount(1);
  await page.getByRole("button", { name: /^Server: 127\.0\.0\.1:43124/ }).click();
  await expect(page.getByRole("menuitem", { name: "This Mac, answering" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Remove this server" }).click();
  await expect(footer(page)).toHaveText("127.0.0.1:43123");
});

test("a hosted browser writes messages without a local machine", async ({ page }) => {
  await page.addInitScript(
    (token) => localStorage.setItem("tokamak.access-token", token),
    process.env.TOKAMAK_E2E_HOSTED_TOKEN!,
  );
  await page.goto("http://127.0.0.1:43124/p/chat");
  await expect(footer(page)).toHaveText("127.0.0.1:43124");
  await page.getByRole("button", { name: /New chat/ }).click();
  await expect(page.getByRole("heading", { name: "Agents run from the desktop app" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Message only", exact: true })).toHaveCount(0);
  const editor = page.getByRole("textbox", { name: "Message" });
  const text = "A message from the hosted browser";
  await editor.fill(text);
  await editor.press("Enter");
  await expect(
    page.getByRole("log", { name: "Conversation" }).getByText(text, { exact: true }),
  ).toBeVisible();
});
