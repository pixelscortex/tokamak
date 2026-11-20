import { test, expect, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const connected = (page: Page) =>
  expect(page.getByRole("status", { name: "Connection status" })).toHaveText("127.0.0.1:43123");
const rail = (page: Page) => page.getByRole("navigation", { name: "Views" });
const tabs = (page: Page) => page.getByRole("navigation", { name: "Open pages" });

// Chat owns "/". Open the fixture by its address to avoid mounting Chat in the fixture window.
const fixtureHome = "/p/integration-fixture";

// Each project gets the same server, so assertions use the observed baseline.
test("live threads, compiler views, regions, per-plugin reload and error containment", async ({
  page,
  context,
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

  const chat = await context.newPage();
  await chat.goto("/p/chat");
  const composer = chat.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeEnabled();
  const draft = "Draft survives another plugin's reload";
  await composer.fill(draft);
  const oldComposer = await composer.elementHandle();
  const oldFixture = await fixture.elementHandle();

  const sentinel = crypto.randomUUID();
  await page.evaluate((value) => {
    (window as unknown as { documentSentinel: string }).documentSentinel = value;
  }, sentinel);
  const source = `${process.env.TOKAMAK_FIXTURE_SOURCE}/src/client/api.tsx`;
  const revision = `Fixture revision ${crypto.randomUUID()}`;
  // The new contribution name proves the other window applied the catalog.
  const throwingTitle = `ThrowingView${crypto.randomUUID().replaceAll("-", "")}`;
  await writeFile(
    source,
    (await readFile(source, "utf8"))
      .replace(/Fixture revision [^<]+/, revision)
      .replace(/export const ThrowingView\w* = view/, `export const ${throwingTitle} = view`),
  );
  const reload = spawnSync("proto", ["run", "bun", "--", "app/scripts/integration-fixture.ts", "--reload"], {
    encoding: "utf8",
  });
  expect(reload.status, reload.stderr + reload.stdout).toBe(0);
  await expect(fixture.getByRole("heading", { name: revision, exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { documentSentinel: string }).documentSentinel),
  ).toBe(sentinel);
  await expect(count).toHaveText(`Fixture live threads: ${initial + 1}`);

  await expect(rail(chat).getByRole("link", { name: throwingTitle, exact: true })).toBeVisible();
  await expect(composer).toHaveValue(draft);
  expect(await oldComposer!.evaluate((element) => element.isConnected)).toBe(true);
  expect(await oldFixture!.evaluate((element) => element.isConnected)).toBe(false);
  await chat.close();

  await rail(page).getByRole("link", { name: throwingTitle, exact: true }).click();
  const failure = page.getByRole("alert", { name: "Plugin view error" });
  await expect(failure).toContainText("Deliberate fixture failure");
  await expect(failure).toContainText("tokamak plugin logs integration-fixture");
  const pluginLog = join(process.env.TOKAMAK_PLUGIN_LOG_DIR!, "integration-fixture.log");
  await expect
    .poll(async () => {
      const log = await readFile(pluginLog, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return log
        .split("\n")
        .slice(0, -1)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    })
    .toContainEqual(
      expect.objectContaining({
        source: "window",
        level: "error",
        text: expect.stringContaining("Deliberate fixture failure"),
      }),
    );
  await expect(failure.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(sidebar).toBeHidden();
  await expect(header.getByRole("heading", { name: throwingTitle })).toBeVisible();
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
        const socket = new WebSocket(`ws://127.0.0.1:43123/ws?token=${token}`);
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
