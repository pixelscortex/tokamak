import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";

const connected = (page: Page) =>
  expect(page.getByRole("status", { name: "Connection status" })).toHaveText("127.0.0.1:43123");
const rail = (page: Page) => page.getByRole("navigation", { name: "Views" });
const tabs = (page: Page) => page.getByRole("navigation", { name: "Open pages" });

// Chat is installed too and, being first in the catalog, owns "/". These tests open
// the fixture by its address so chat never mounts (it creates a thread on first use).
const fixtureHome = "/p/integration-fixture";
const windowStateRoute = `${fixtureHome}/window-state`;

async function publishFixtureRevision(request: APIRequestContext) {
  const source = `${process.env.TOKAMAK_FIXTURE_SOURCE}/src/client/api.tsx`;
  const revision = `Fixture revision ${crypto.randomUUID()}`;
  await writeFile(source, (await readFile(source, "utf8")).replace(/Fixture revision [^"]+/, revision));
  const built = spawnSync(
    "proto",
    ["run", "bun", "--", "packages/build/src/build.ts", process.env.TOKAMAK_FIXTURE_SOURCE!],
    { stdio: "inherit" },
  );
  expect(built.status).toBe(0);
  await cp(`${process.env.TOKAMAK_FIXTURE_SOURCE}/dist`, `${process.env.TOKAMAK_PLUGIN_DIR}/fixture/dist`, {
    recursive: true,
  });
  const reload = await request.post("http://127.0.0.1:43123/plugins/integration-fixture/reload", {
    headers: { Authorization: `Bearer ${process.env.VITE_TOKAMAK_TOKEN}` },
  });
  expect(reload.ok()).toBe(true);
  return revision;
}

async function saveDraft(page: Page, draft: string) {
  await page.getByRole("textbox", { name: "Draft" }).fill(draft);
  await page.getByRole("button", { name: "Save drafts" }).click();
  await expect(page.getByText(`Window draft: ${draft}`)).toBeVisible();
}

test("an authenticated plugin stylesheet applies and retires on reload under the app CSP", async ({
  page,
  request,
}) => {
  const cssRequest = page.waitForRequest((request) => {
    const path = new URL(request.url()).pathname;
    return path.startsWith("/plugins/integration-fixture/") && path.endsWith("/styles.css");
  });
  const appliedStyle = () =>
    page.evaluate(() => {
      const fixture = document.querySelector('[aria-label="Integration fixture"]');
      return fixture && getComputedStyle(fixture).getPropertyValue("--fixture-stylesheet").trim();
    });
  await page.goto(fixtureHome);
  await connected(page);
  await expect.poll(appliedStyle).toBe("loaded");

  const asset = await cssRequest;
  const stylesheet = new URL(asset.url());
  expect(asset.method()).toBe("GET");
  expect(stylesheet.origin).toBe("http://127.0.0.1:43123");
  expect(stylesheet.search).toBe("");
  expect((await asset.headerValue("authorization")) === `Bearer ${process.env.VITE_TOKAMAK_TOKEN}`).toBe(
    true,
  );
  expect((await request.get(stylesheet.href)).status()).toBe(401);

  const oldSheet = await page.evaluateHandle(() =>
    document.adoptedStyleSheets.find((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.includes("--fixture-stylesheet")),
    ),
  );
  expect(await oldSheet.evaluate((sheet) => !!sheet)).toBe(true);
  const revision = await publishFixtureRevision(request);
  await expect(page.getByRole("heading", { name: revision, exact: true })).toBeVisible();
  await expect
    .poll(() => oldSheet.evaluate((sheet) => !!sheet && document.adoptedStyleSheets.includes(sheet)))
    .toBe(false);
  await expect.poll(appliedStyle).toBe("loaded");
  await oldSheet.dispose();
});

// Each project gets the same server, so assertions use the observed baseline.
test("live threads, compiler views, regions, revision replacement and error containment", async ({
  page,
  context,
  request,
}) => {
  await page.goto(fixtureHome);
  await connected(page);
  const fixture = page.getByRole("region", { name: "Integration fixture" });
  const count = fixture.getByRole("status", { name: "Fixture thread count" });
  await expect(count).toHaveText(/Fixture live threads: \d+/);
  const initial = Number((await count.innerText()).split(": ")[1]);
  const second = await context.newPage();
  await second.goto(fixtureHome);
  const secondCount = second.getByRole("status", { name: "Fixture thread count" });
  await expect(secondCount).toHaveText(`Fixture live threads: ${initial}`);

  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const header = page.getByRole("banner", { name: "Page header" });
  await expect(sidebar.getByRole("listbox", { name: "Fixture threads" })).toBeAttached();
  await expect(header.getByRole("heading", { name: "Fixture header" })).toBeVisible();

  const title = `Browser thread ${crypto.randomUUID()}`;
  await page.getByRole("textbox", { name: "New thread title" }).fill(title);
  await sidebar.getByRole("button", { name: "New fixture thread", exact: true }).click();
  await expect(count).toHaveText(`Fixture live threads: ${initial + 1}`);
  await expect(secondCount).toHaveText(`Fixture live threads: ${initial + 1}`);
  await expect(second.getByRole("listbox", { name: "Fixture threads" })).toContainText(title);

  const sentinel = crypto.randomUUID();
  await page.evaluate((value) => {
    (window as unknown as { documentSentinel: string }).documentSentinel = value;
  }, sentinel);
  const revision = await publishFixtureRevision(request);
  await expect(fixture.getByRole("heading", { name: revision, exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { documentSentinel: string }).documentSentinel),
  ).toBe(sentinel);
  await expect(count).toHaveText(`Fixture live threads: ${initial + 1}`);

  await rail(page).getByRole("link", { name: "ThrowingView", exact: true }).click();
  const failure = page.getByRole("alert", { name: "Plugin view error" });
  await expect(failure).toContainText("Deliberate fixture failure");
  await expect(failure.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(sidebar).toBeHidden();
  await expect(header.getByRole("heading", { name: "ThrowingView" })).toBeVisible();
  await connected(page);
  await second
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("button", { name: "New fixture thread" })
    .click();
  await expect(secondCount).toHaveText(`Fixture live threads: ${initial + 2}`);
  await rail(page).getByRole("link", { name: "FixtureView", exact: true }).click();
  await expect(count).toHaveText(`Fixture live threads: ${initial + 2}`);
});

test("the frame: keyboard sidebar, rail, tabs, panel, search and theme", async ({ page }) => {
  await page.goto(fixtureHome);
  await connected(page);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar).toBeVisible();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(sidebar).toBeHidden();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(sidebar).toBeVisible();

  await rail(page).getByRole("link", { name: "PanelView", exact: true }).click();
  await expect(rail(page).getByRole("link", { name: "PanelView" })).toHaveAttribute("aria-current", "page");
  const panel = page.getByRole("region", { name: "Panel", exact: true });
  await expect(panel).toContainText("Fixture panel");
  await expect(tabs(page).getByRole("button", { name: /^\w+View$/ })).toHaveText([
    "FixtureView",
    "PanelView",
  ]);
  await tabs(page).getByRole("button", { name: "Close PanelView" }).click();
  await expect(page).toHaveURL(/\/p\/integration-fixture$/);
  await expect(panel).toBeHidden();
  await expect(tabs(page).getByRole("button", { name: /^\w+View$/ })).toHaveText(["FixtureView"]);

  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("combobox", { name: "Search views and commands" });
  await search.fill("Panel");
  await page.getByRole("option", { name: "PanelView" }).click();
  // Settings opens straight away: the closing search must not swallow the press or take focus back.
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Dark" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page).toHaveURL(/\/panel$/);
  await page.keyboard.press("ControlOrMeta+[");
  await expect(page).toHaveURL(/\/p\/integration-fixture$/);
  await page.keyboard.press("ControlOrMeta+]");
  await expect(page).toHaveURL(/\/panel$/);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitemradio", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await connected(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitemradio", { name: "System" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("server refuses a disallowed browser origin", async ({ page, request }) => {
  const response = await request.get("http://127.0.0.1:43123/plugins", {
    headers: { Origin: "http://127.0.0.1:1421" },
  });
  expect(response.status()).toBe(403);
  expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  await page.goto("http://127.0.0.1:1421");
  const accepted = await page.evaluate(
    (token) =>
      new Promise<boolean>((resolve) => {
        const socket = new WebSocket("ws://127.0.0.1:43123/ws", ["tokamak", `tokamak.bearer.${token}`]);
        socket.onopen = () => {
          socket.close();
          resolve(true);
        };
        socket.onerror = () => resolve(false);
        socket.onclose = () => resolve(false);
        setTimeout(() => {
          socket.close();
          resolve(true);
        }, 10_000);
      }),
    process.env.VITE_TOKAMAK_TOKEN,
  );
  expect(accepted).toBe(false);
  const unreachable = page.getByRole("alert", { name: "Server unreachable" });
  await expect(unreachable).toBeVisible();
  await expect(unreachable.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("window state survives according to its keep option", async ({ page, browser }) => {
  const draft = crypto.randomUUID();
  await page.goto(windowStateRoute);
  await connected(page);
  await saveDraft(page, draft);

  await page.reload();
  await expect(page.getByText("Window draft: empty")).toBeVisible();
  await expect(page.getByText(`Device draft: ${draft}`)).toBeVisible();
  await expect(page.getByText(`Personal draft: ${draft}`)).toBeVisible();

  const otherDevice = await browser.newContext();
  try {
    const other = await otherDevice.newPage();
    await other.goto(new URL(windowStateRoute, page.url()).href);
    await expect(other.getByText(`Personal draft: ${draft}`)).toBeVisible();
    await expect(other.getByText("Device draft: empty")).toBeVisible();
  } finally {
    await otherDevice.close();
  }
});

test("un-kept state survives a plugin revision in the same window", async ({ page, request }) => {
  const draft = crypto.randomUUID();
  await page.goto(windowStateRoute);
  await saveDraft(page, draft);
  const revision = await publishFixtureRevision(request);
  await expect(page.getByRole("heading", { name: revision, exact: true })).toBeVisible();
  await expect(page.getByText(`Window draft: ${draft}`)).toBeVisible();
});

test("plugins with the same state key keep separate drafts in one window", async ({ page }) => {
  await page.goto(windowStateRoute);
  await saveDraft(page, "First plugin draft");
  await rail(page).getByRole("link", { name: "OtherDraftView", exact: true }).click();
  await expect(page.getByText("Window draft: empty")).toBeVisible();
  await saveDraft(page, "Second plugin draft");
  await rail(page).getByRole("link", { name: "WindowStateView", exact: true }).click();
  await expect(page.getByText("Window draft: First plugin draft")).toBeVisible();
  await rail(page).getByRole("link", { name: "OtherDraftView", exact: true }).click();
  await expect(page.getByText("Window draft: Second plugin draft")).toBeVisible();
});

test("dragged dividers keep their sizes across a reload, and the sidebar and panel stay mounted when hidden", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(fixtureHome);
  await connected(page);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const panel = page.getByRole("region", { name: "Panel", exact: true });
  const width = async (box: typeof sidebar) => (await box.boundingBox())!.width;
  const press = async (divider: string, key: string) => {
    await page.getByRole("separator", { name: divider }).focus();
    for (let n = 0; n < 4; n++) await page.keyboard.press(key);
  };

  // The dividers move with the keyboard as with the pointer; the sizes are kept on release.
  await expect(sidebar).toBeVisible();
  const sidebarBefore = await width(sidebar);
  await press("Resize sidebar", "ArrowRight");
  await expect.poll(() => width(sidebar)).toBeGreaterThan(sidebarBefore + 8);
  const sidebarAfter = await width(sidebar);

  // Hiding the sidebar keeps the same element, so what plugins rendered into it is not mounted again.
  await page.evaluate(() => {
    (document.querySelector('aside[aria-label="Sidebar"]') as HTMLElement & { probe?: string }).probe =
      "kept";
  });
  await page.keyboard.press("ControlOrMeta+b");
  await expect(sidebar).toBeHidden();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(sidebar).toBeVisible();
  expect(
    await page.evaluate(
      () => (document.querySelector('aside[aria-label="Sidebar"]') as HTMLElement & { probe?: string }).probe,
    ),
  ).toBe("kept");

  await rail(page).getByRole("link", { name: "PanelView", exact: true }).click();
  await expect(panel).toContainText("Fixture panel");
  const panelBefore = await width(panel);
  await press("Resize panel", "ArrowLeft");
  await expect.poll(() => width(panel)).toBeGreaterThan(panelBefore + 8);
  const panelAfter = await width(panel);
  // Leaving the panel's view hides the panel; coming back finds the same element.
  await page.evaluate(() => {
    (document.querySelector('section[aria-label="Panel"]') as HTMLElement & { probe?: string }).probe =
      "kept";
  });
  await rail(page).getByRole("link", { name: "FixtureView", exact: true }).click();
  await expect(panel).toBeHidden();
  await rail(page).getByRole("link", { name: "PanelView", exact: true }).click();
  await expect(panel).toContainText("Fixture panel");
  expect(
    await page.evaluate(
      () => (document.querySelector('section[aria-label="Panel"]') as HTMLElement & { probe?: string }).probe,
    ),
  ).toBe("kept");

  await page.reload();
  await connected(page);
  await expect(panel).toContainText("Fixture panel");
  await expect.poll(() => width(panel)).toBeCloseTo(panelAfter, 0);
  await rail(page).getByRole("link", { name: "FixtureView", exact: true }).click();
  await expect.poll(() => width(sidebar)).toBeCloseTo(sidebarAfter, 0);
});
