import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { asDesktop } from "./desktop";

// Screenshots of the thread view for comparing with the Paper pages, not a
// check: it runs only when TOKAMAK_SCREENS names a folder to write them to.
//   TOKAMAK_SCREENS=/some/folder proto run bun -- e2e/browser.ts screens.spec.ts --project chromium
const out = process.env.TOKAMAK_SCREENS;
test.skip(!out, "set TOKAMAK_SCREENS to a folder to take the screenshots");

const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
const conversation = (page: Page) => page.getByRole("log", { name: "Conversation" });
const agentRow = (page: Page) => page.getByRole("group", { name: "Agent" });

async function pick(page: Page, replay: string) {
  await agentRow(page).getByRole("button").first().click();
  await page.getByRole("menuitem", { name: "Fake agent" }).click();
  await agentRow(page).getByRole("button").nth(1).click();
  await page.getByRole("menuitem", { name: replay, exact: true }).click();
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
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(out!, `${name}.png`) });

test("thread screens", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 1728, height: 1117 }, deviceScaleFactor: 2 });
  try {
    const { home } = await asDesktop(context);
    const page = await context.newPage();
    await page.goto("/");
    await pick(page, "work");
    await shot(page, "new-thread");

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
    await expect(replies.first().getByRole("button", { name: /^5 actions/ })).toBeVisible();
    await shot(page, "reply-finished");
    await replies
      .first()
      .getByRole("button", { name: /^5 actions/ })
      .click();
    await replies.first().getByRole("button", { name: "Thinking" }).click();
    await shot(page, "reply-opened");
    await replies
      .first()
      .getByRole("button", { name: /^5 actions/ })
      .click();
    await replies.first().getByRole("button", { name: "Thinking" }).click();

    // A turn that edits a file: the change card, then the review panel.
    await unlinkGo(folder);
    await agentRow(page).getByRole("button").nth(1).click();
    await page.getByRole("menuitem", { name: "edit", exact: true }).click();
    await writeFile(join(folder, "go"), "");
    await send(page, "Add a CSV export to the invoices page.");
    await expect(conversation(page).getByText("I edited agent.txt.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Review turn/ })).toBeVisible();
    await shot(page, "change-card");
    await page.getByRole("button", { name: /^Review turn/ }).click();
    await expect(
      page.getByRole("region", { name: "Review" }).getByRole("list", { name: "Changed files" }),
    ).toBeVisible();
    await shot(page, "review-panel");
    await page.getByRole("button", { name: "Thread only" }).click();

    // A few more threads for the list.
    for (const title of ["Paginate customer list", "PDF dark mode"]) {
      await page.getByRole("button", { name: /^New thread/ }).click();
      await pick(page, "quick");
      await send(page, title);
      await expect(conversation(page).getByText(`Done: ${title}`)).toBeVisible();
    }
    await shot(page, "thread-list");
  } finally {
    await context.close();
  }
});

async function unlinkGo(folder: string) {
  const { unlink } = await import("node:fs/promises");
  await unlink(join(folder, "go")).catch(() => {});
}
