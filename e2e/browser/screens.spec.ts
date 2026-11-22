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
  const context = await browser.newContext({
    viewport: { width: 1728, height: 1117 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
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
    await agentRow(page).getByRole("button").nth(1).click();
    await page.getByRole("menuitem", { name: "edit", exact: true }).click();
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
    await shot(page, "thread-list");
  } finally {
    await context.close();
  }
});

async function unlinkGo(folder: string) {
  const { unlink } = await import("node:fs/promises");
  await unlink(join(folder, "go")).catch(() => {});
}
