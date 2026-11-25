import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { startHostedFixture } from "../hosted-fixture";
import { agentChip, pickAgentOption } from "./agent-picker";
import { asDesktop } from "./desktop";
import { screenTree } from "./screen-tree";

// Screenshots of the thread view for comparing with the Paper pages, not a
// check: it runs only when TOKAMAK_SCREENS names a folder to write them to.
//   TOKAMAK_SCREENS=/some/folder proto run bun -- e2e/browser.ts screens.spec.ts --project chromium
const out = process.env.TOKAMAK_SCREENS;
test.skip(!out, "set TOKAMAK_SCREENS to a folder to take the screenshots");

const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
const conversation = (page: Page) => page.getByRole("log", { name: "Conversation" });

async function pick(page: Page, replay: string) {
  await pickAgentOption(page, "Fake agent", replay);
}

async function useFolder(page: Page, folder: string) {
  await page.getByRole("button", { name: "Choose a folder…" }).click();
  await page.getByRole("textbox", { name: "Folder path" }).fill(folder);
  await page.getByRole("button", { name: "Use folder" }).click();
}

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await expect(conversation(page).getByText(text, { exact: true })).toBeVisible();
  await expect(composer(page)).toHaveValue("");
}

// Each screenshot also writes the drawn tree (screen-tree.ts) for the Paper copy of the app.
async function shot(page: Page, name: string) {
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
const screen = {
  viewport: { width: 1728, height: 1117 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
} as const;

// Runs first, on a fresh server: chat on its own (a plain browser has no local
// part, so ai and code draw nothing) and the shell's own pages.
test("chat alone and shell screens", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext(screen);
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
    // A plain browser stores a typed folder as typed, so the example path needs no folder.
    await useFolder(page, "/example/project");
    await shot(page, "chat-new-thread");
    await composer(page).fill("Fix the session test");
    await shot(page, "chat-composer-typing");
    await composer(page).press("Enter");
    await expect(conversation(page).getByText("Fix the session test", { exact: true })).toBeVisible();
    await composer(page).fill("It fails since the token refresh change.");
    await composer(page).press("Enter");
    await expect(conversation(page).getByText("It fails since the token refresh change.")).toBeVisible();
    // The text stays in the composer until the message has arrived.
    await expect(composer(page)).toHaveValue("");
    await shot(page, "chat-open-thread");
    await page.getByRole("button", { name: "Thread actions" }).click();
    await shot(page, "chat-thread-menu");
    await page.keyboard.press("Escape");

    await page.goto("/welcome");
    await expect(page.getByRole("region", { name: "Welcome" })).toBeVisible();
    await shot(page, "shell-welcome");
    await page.goto("/connect");
    await expect(page.getByRole("textbox", { name: "Server address" })).toBeVisible();
    await shot(page, "shell-connect");
    await page.goto("/settings/members");
    await expect(page.getByText("Members are managed on a shared server.")).toBeVisible();
    await shot(page, "shell-members-this-mac");
    await page.goto("/");
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
    await page.goto(shared.url);
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

test("thread screens", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext(screen);
  try {
    const { home } = await asDesktop(context);
    const page = await context.newPage();
    await page.goto("/");
    await pick(page, "work");
    await shot(page, "new-thread");
    // The agent picker open over the new thread's composer.
    await agentChip(page).click();
    await expect(page.getByRole("menu")).toHaveCSS("opacity", "1");
    await shot(page, "picker-open");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();

    // A Git folder, so the branch, the change card and the review panel show.
    const folder = join(home, "invoices-app");
    await mkdir(folder);
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: folder,
        env: {
          ...process.env,
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
        },
      });
    git("init", "--quiet", "-b", "feat/csv-export");
    await writeFile(join(folder, "README.md"), "# Invoices\n");
    await useFolder(page, folder);

    await send(page, "The session test fails since the token refresh change. Fix it, keep the public API.");
    const replies = conversation(page).getByRole("article", { name: /^Fake agent at / });
    await expect(replies.first().getByRole("button", { name: /Running pnpm test auth/ })).toBeVisible();
    await shot(page, "reply-running");

    await writeFile(join(folder, "go"), "");
    await expect(replies.first().getByRole("button", { name: /^Worked\s*5 actions/ })).toBeVisible();
    await shot(page, "reply-finished");
    await replies
      .first()
      .getByRole("button", { name: /^Worked\s*5 actions/ })
      .click();
    await replies.first().getByRole("button", { name: "Thinking" }).click();
    await shot(page, "reply-opened");
    await replies
      .first()
      .getByRole("button", { name: /^Worked\s*5 actions/ })
      .click();
    await replies.first().getByRole("button", { name: "Thinking" }).click();

    // A turn that edits a file: the change card, then the review panel.
    await unlinkGo(folder);
    await pick(page, "edit");
    const lines = Array.from(
      { length: 240 },
      (_, n) => `  const value${n} = format(rows[${n}], columns, { plain: true, locale: "en" });`,
    );
    await writeFile(join(folder, "export.ts"), lines.join("\n") + "\n");
    git("add", "-A");
    git("-c", "user.name=Sam", "-c", "user.email=sam@example.com", "commit", "-qm", "start");
    await send(page, "Add a CSV export to the invoices page.");
    // The replay holds after its text: edit while the turn runs (a long edit, and a file the
    // operating system writes), then let it end.
    await expect(conversation(page).getByText("I edited agent.txt.")).toBeVisible();
    const edited = [...lines];
    edited.splice(
      10,
      3,
      "  // The export reads the table's own column list, so the file and the screen can't drift apart, ever.",
    );
    for (const at of [60, 110, 160, 210])
      edited.splice(at, 2, `  const total${at} = sum(rows.slice(0, ${at}));`);
    edited.push("  export const csv = toCsv(rows, columns);");
    await writeFile(join(folder, "export.ts"), edited.join("\n") + "\n");
    await writeFile(join(folder, ".DS_Store"), Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31]));
    await writeFile(join(folder, "go"), "");
    await expect(page.getByRole("button", { name: /^Review turn 2/ })).toBeVisible();
    await shot(page, "change-card");
    await page.getByRole("button", { name: /^Review turn 2/ }).click();
    await expect(
      page.getByRole("region", { name: "Review" }).getByRole("list", { name: "Changed files" }),
    ).toBeVisible();
    await shot(page, "review-panel");
    // The scrollbar's two hover steps: pointer in the panel, then on the thumb.
    const review = page.getByRole("region", { name: "Review" });
    const thumb = review.locator("[data-slot=scroll-area-thumb]").first();
    const colour = () => thumb.evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(1200);
    console.log("thumb at rest", await colour());
    await review.hover({ position: { x: 200, y: 400 } });
    await page.waitForTimeout(400);
    console.log("thumb, pointer in the panel", await colour());
    await review.screenshot({ path: join(out!, "scrollbar-panel-hover.png") });
    await thumb.hover({ force: true });
    await page.waitForTimeout(400);
    console.log("thumb hovered", await colour());
    await review.screenshot({ path: join(out!, "scrollbar-thumb-hover.png") });
    await page.getByRole("button", { name: "Thread only" }).click();

    // A few more threads for the list.
    for (const title of ["Paginate customer list", "PDF dark mode"]) {
      await page.getByRole("button", { name: /^New thread/ }).click();
      await pick(page, "quick");
      await send(page, title);
      await expect(conversation(page).getByText(`Done: ${title}`)).toBeVisible();
    }
    // Every turn has ended: no Stop in the composer, no spinner in the list.
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await shot(page, "thread-list");

    // Ask first: the permission question on the composer's tray, and the waiting thread.
    await page.getByRole("button", { name: /^New thread/ }).click();
    await pick(page, "ask-once");
    await pickAgentOption(page, "Access level", "Ask first");
    await send(page, "Push the branch");
    const question = page.getByRole("group", { name: "Permission question" });
    await expect(question).toBeVisible();
    await shot(page, "permission-card");
    await question.getByRole("button", { name: "Approve" }).click();
    await expect(question).toHaveCount(0);

    // Steers: two follow-ups sent while the reply ran, each drawn where it arrived.
    await page.getByRole("button", { name: /^New thread/ }).click();
    await pick(page, "steer");
    await send(page, "Rename the export button to Download CSV.");
    await expect(conversation(page).getByText("Ready for steering.")).toBeVisible();
    await send(page, "Also keep the old label as a tooltip");
    await expect(conversation(page).getByText("Steered: Also keep the old label as a tooltip")).toBeVisible();
    await send(page, "Then run the tests");
    await expect(conversation(page).getByText("Then: Then run the tests")).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await shot(page, "reply-steered");
  } finally {
    await context.close();
  }
});

async function unlinkGo(folder: string) {
  const { unlink } = await import("node:fs/promises");
  await unlink(join(folder, "go")).catch(() => {});
}
