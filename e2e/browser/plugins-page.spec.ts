// Settings → Plugins (app/src/shell/plugins.tsx) against a desktop Runner whose plugins
// folder this file fills with fixture builds only. The browser build's own path (no
// "Reveal in Finder") is covered by the last test, on the suite's shared server.
import { test, expect, type Page } from "@playwright/test";
import { cp, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asDesktop } from "./desktop";
import { screenTree } from "./screen-tree";

/** The integration fixture as the runner built it (e2e/browser.ts). */
const fixtureBuild = () => `${process.env.TOKAMAK_PLUGIN_DIR}/fixture/dist`;

async function pluginsFolder() {
  return realpath(await mkdtemp(join(dirname(process.env.TOKAMAK_PLUGIN_DIR!), "plugins-page-")));
}

async function installFixture(folder: string) {
  await cp(fixtureBuild(), join(folder, "fixture", "dist"), { recursive: true });
}

/** A folder holding plugin source and no build, which the server skips as "not built". */
async function addUnbuilt(folder: string) {
  await mkdir(join(folder, "unbuilt"), { recursive: true });
  await writeFile(join(folder, "unbuilt", "package.json"), "{}");
}

const pluginsPage = (page: Page) => page.getByRole("region", { name: "Plugins" });
const row = (page: Page, name: string) => pluginsPage(page).getByRole("listitem", { name, exact: true });

test("an empty plugins folder: the notice links to the page, which shows the folder", async ({
  page,
  context,
}) => {
  const folder = await pluginsFolder();
  const desktop = await asDesktop(context, { plugins: folder });
  await page.goto("/");
  const notice = page.getByRole("status", { name: "No plugins" });
  await expect(notice.getByRole("heading", { name: "No plugins installed" })).toBeVisible();
  await notice.getByRole("button", { name: "Open Settings → Plugins" }).click();
  await expect(page).toHaveURL(/\/settings\/plugins$/);

  await expect(pluginsPage(page).getByLabel("Plugins folder path")).toHaveText(folder);
  await expect(pluginsPage(page).getByText("Plugin builds placed in this folder are loaded.")).toBeVisible();
  await expect(pluginsPage(page).getByRole("listitem")).toHaveCount(0);
  await pluginsPage(page).getByRole("button", { name: "Reveal in Finder" }).click();
  await expect.poll(() => desktop.revealed).toBe(1);
  // Read-only: the folder action is the only button on the page.
  await expect(pluginsPage(page).getByRole("button")).toHaveCount(1);
});

test("a loaded fixture and a skipped folder, and the list follows a reload", async ({ page, context }) => {
  const folder = await pluginsFolder();
  await installFixture(folder);
  await addUnbuilt(folder);
  const desktop = await asDesktop(context, { plugins: folder });
  await page.goto("/settings/plugins");

  const fixture = row(page, "integration-fixture");
  await expect(fixture).toContainText("Loaded");
  await expect(fixture).toContainText("1.0.0");
  await expect(fixture).toContainText(join(folder, "fixture"));
  const unbuilt = row(page, "unbuilt");
  await expect(unbuilt).toContainText("Failed");
  await expect(unbuilt).toContainText("not built");
  await expect(unbuilt).toContainText(join(folder, "unbuilt"));

  // A second broken folder and a reload: the page catches up without a restart.
  await mkdir(join(folder, "bad-manifest", "dist"), { recursive: true });
  await writeFile(join(folder, "bad-manifest", "dist", "manifest.json"), "not json");
  const reload = await fetch(`${desktop.endpoint.http}/plugins/integration-fixture/reload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${desktop.endpoint.token}` },
  });
  expect(reload.ok).toBe(true);
  await expect(row(page, "bad-manifest")).toContainText("Failed");
  await expect(row(page, "integration-fixture")).toContainText("Loaded");
});

test("the page renders when every plugin failed", async ({ page, context }) => {
  const folder = await pluginsFolder();
  await addUnbuilt(folder);
  await asDesktop(context, { plugins: folder });
  await page.goto("/settings/plugins");
  await expect(row(page, "unbuilt")).toContainText("not built");
  await expect(pluginsPage(page).getByLabel("Plugins folder path")).toHaveText(folder);
});

test("in the browser build the folder is text with no action", async ({ page }) => {
  await page.goto("/settings/plugins");
  await expect(pluginsPage(page).getByLabel("Plugins folder path")).not.toBeEmpty();
  await expect(pluginsPage(page).getByRole("button", { name: "Reveal in Finder" })).toHaveCount(0);
  await expect(row(page, "integration-fixture")).toContainText("Loaded");
});

// The three states for the Paper copy (design/README.md, "How the Paper pages are made").
// Not a check: runs only when TOKAMAK_SCREENS names a folder to write to.
test("plugins page screens", async ({ browser }) => {
  const out = process.env.TOKAMAK_SCREENS;
  test.skip(!out, "set TOKAMAK_SCREENS to a folder to take the screenshots");
  const shot = async (page: Page, name: string) => {
    const tree = await screenTree(page);
    await page.screenshot({ path: join(out!, `${name}.png`) });
    await writeFile(join(out!, `${name}.json`), JSON.stringify(tree));
  };
  const open = async (fill: (folder: string) => Promise<void>) => {
    const context = await browser.newContext({
      viewport: { width: 1728, height: 1117 },
      deviceScaleFactor: 2,
      colorScheme: "dark",
    });
    const folder = await pluginsFolder();
    await fill(folder);
    await asDesktop(context, { plugins: folder });
    const page = await context.newPage();
    await page.goto("/settings/plugins");
    await expect(pluginsPage(page).getByLabel("Plugins folder path")).toHaveText(folder);
    return { context, page };
  };
  for (const [name, fill] of [
    ["shell-plugins", installFixture],
    [
      "shell-plugins-failed",
      async (folder: string) => {
        await installFixture(folder);
        await addUnbuilt(folder);
      },
    ],
    ["shell-plugins-empty", async () => {}],
  ] as const) {
    const { context, page } = await open(fill);
    if (name !== "shell-plugins-empty")
      await expect(row(page, "integration-fixture")).toContainText("Loaded");
    else
      await expect(
        pluginsPage(page).getByText("Plugin builds placed in this folder are loaded."),
      ).toBeVisible();
    await shot(page, name);
    await context.close();
  }
});
