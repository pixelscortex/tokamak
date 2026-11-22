import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { installFakeAgent } from "../fake-agent/local.mjs";
import { asDesktop } from "./desktop";

// The agent row's pickers and what belongs to a thread (TKM-224), on a desktop
// page running the real local part with two fake agents: "Fake agent" offers
// modes but no levels or speeds, "Other agent" levels and speeds but no modes. The `context` replay says
// back what the agent was given (see e2e/fake-agent).

const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
const send = (page: Page) => page.getByRole("button", { name: "Send" });
const conversation = (page: Page) => page.getByRole("log", { name: "Conversation" });
const agentRow = (page: Page) => page.getByRole("group", { name: "Agent" });
const picker = (page: Page, name: string) =>
  agentRow(page).getByRole("button", { name: new RegExp(`^${name}: `) });

/** Opens the row's `name` picker (which asks the agents again) and picks `option`. */
async function pick(page: Page, name: string, option: string) {
  await picker(page, name).click();
  await page.getByRole("menuitem", { name: option, exact: true }).click();
}

/** Opens and closes the agent picker: the agents are asked for their `info` again. */
async function lookAgain(page: Page) {
  await picker(page, "Agent").click();
  await page.keyboard.press("Escape");
}

test("each picker shows only what the agent offers, and Send waits while the agent is signed out or missing", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const { home, bin } = await asDesktop(context);
  const page = await context.newPage();
  await page.goto("/");

  // Other agent: agent, model, level, speed and permission level (no modes); every thread starts on Full access.
  await pick(page, "Agent", "Other agent");
  await pick(page, "Model", "context");
  for (const [name, value] of [
    ["Agent", "Other agent"],
    ["Model", "context"],
    ["Level", "Low"],
    ["Speed", "Standard"],
    ["Permission level", "Full access"],
  ])
    await expect(picker(page, name)).toHaveText(`${name}: ${value}`);
  await expect(picker(page, "Mode")).toHaveCount(0);
  // Fake agent offers no levels or speeds, but modes: a mode is not a speed.
  await pick(page, "Agent", "Fake agent");
  await expect(picker(page, "Model")).toBeVisible();
  await expect(picker(page, "Level")).toHaveCount(0);
  await expect(picker(page, "Speed")).toHaveCount(0);
  await expect(picker(page, "Mode")).toHaveText("Mode: Default");
  await expect(picker(page, "Permission level")).toBeVisible();

  // Signed out: only the text, no other picker, and Send is off (the button and Enter).
  await mkdir(join(home, ".other-agent"), { recursive: true });
  await writeFile(join(home, ".other-agent", "signed-out"), "");
  await pick(page, "Agent", "Other agent");
  await expect(agentRow(page).getByRole("status")).toHaveText(
    "Other agent is signed out. Sign in, then come back.",
  );
  await expect(picker(page, "Model")).toHaveCount(0);
  await expect(picker(page, "Permission level")).toHaveCount(0);
  await composer(page).fill("Add a CSV export");
  await expect(send(page)).toBeDisabled();
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveValue("Add a CSV export");

  // Signed in again: seen the next time a picker opens, without a restart.
  await unlink(join(home, ".other-agent", "signed-out"));
  await lookAgain(page);
  await expect(agentRow(page).getByRole("status")).toHaveCount(0);
  await expect(send(page)).toBeEnabled();

  // Not installed, then installed.
  await unlink(join(bin, "other-agent"));
  await lookAgain(page);
  await expect(agentRow(page).getByRole("status")).toHaveText("Other agent isn't installed.");
  await expect(send(page)).toBeDisabled();
  await installFakeAgent(bin, ["other-agent"]);
  await lookAgain(page);
  await expect(send(page)).toBeEnabled();
  await context.close();
});

test("the choices belong to the thread, apply to its next turn, and a switched agent gets the conversation", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const { home } = await asDesktop(context);
  const page = await context.newPage();
  await page.goto("/");
  await pick(page, "Agent", "Other agent");
  await pick(page, "Model", "context");
  await pick(page, "Level", "High");
  await pick(page, "Permission level", "Ask first");

  const folder = join(home, `project-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(folder);
  await page.getByRole("button", { name: "Choose a folder…" }).click();
  await page.getByRole("textbox", { name: "Folder path" }).fill(folder);
  await page.getByRole("button", { name: "Use folder" }).click();

  const replies = conversation(page).getByRole("article", { name: / at / });
  // Sends `text` as a new turn and waits until that turn has ended: Enter while a turn runs would steer it.
  const say = async (text: string) => {
    await composer(page).fill(text);
    await composer(page).press("Enter");
    await expect(replies.filter({ hasText: `Message: ${text}` })).toBeVisible();
    await expect(agentRow(page).getByText("esc to stop")).toHaveCount(0);
  };
  const first = `Plan the export ${crypto.randomUUID().slice(0, 8)}`;
  await say(first);
  const firstReply = replies.filter({ hasText: `Message: ${first}` });
  await expect(firstReply).toContainText("Fresh session");
  await expect(firstReply).toContainText("model context, level high, speed standard, mode -, access ask");

  // The open thread shows its own choices; changing them applies to the next turn, which carries on the session.
  await expect(picker(page, "Permission level")).toHaveText("Permission level: Ask first");
  await pick(page, "Level", "Low");
  await pick(page, "Speed", "Fast");
  await say("Now write it");
  const second = replies.filter({ hasText: "Message: Now write it" });
  await expect(second).toContainText("Carrying on other-agent-");
  await expect(second).toContainText("model context, level low, speed fast, mode -, access ask");

  // Switching agent mid-thread: the new agent starts fresh with the whole conversation so far.
  await pick(page, "Agent", "Fake agent");
  await pick(page, "Model", "context");
  await pick(page, "Mode", "Plan");
  await say("Review it");
  const switched = replies.filter({ hasText: "Message: Review it" });
  await expect(switched).toHaveAccessibleName(/^Fake agent at /);
  await expect(switched).toContainText("Fresh session");
  await expect(switched).toContainText("level -, speed -, mode plan, access ask");
  await expect(switched).toContainText(`: ${first}`);
  await expect(switched).toContainText("agent Other agent: Fresh session");
  await expect(switched).toContainText(": Now write it");

  // A new thread starts on Full access, with this device's last agent.
  await page
    .getByRole("navigation", { name: "Chat threads" })
    .getByRole("button", { name: /New thread/ })
    .click();
  await expect(picker(page, "Agent")).toHaveText("Agent: Fake agent");
  await expect(picker(page, "Permission level")).toHaveText("Permission level: Full access");
  // Back in the thread, its own choices are still there.
  await page.getByRole("option", { name: new RegExp(first) }).click();
  await expect(picker(page, "Agent")).toHaveText("Agent: Fake agent");
  await expect(picker(page, "Permission level")).toHaveText("Permission level: Ask first");
  await context.close();
});

test("a long model menu stays inside a short window and scrolls to its last model", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await asDesktop(context);
  const page = await context.newPage();
  await page.goto("/");
  await pick(page, "Agent", "Fake agent");
  await picker(page, "Model").click();
  const menu = page.getByRole("menu", { name: /^Model: / });
  const models = menu.getByRole("menuitem");
  // Every replay is a model of the fake agent: far more than 720 px of rows.
  expect(await models.count()).toBeGreaterThan(15);
  const box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(720);
  expect(await menu.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const last = (await models.last().textContent())!.trim();
  await models.last().click();
  await expect(picker(page, "Model")).toHaveText(`Model: ${last}`);
  await context.close();
});
