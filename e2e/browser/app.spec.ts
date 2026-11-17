import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";

// Each project gets the same server, so assertions use the observed baseline.
test("live threads, compiler views, revision replacement and error containment", async ({
  page,
  context,
  request,
}) => {
  await page.goto("/");
  const connection = page.getByRole("status", { name: "Connection status" });
  await expect(connection).toHaveText("Connected to real Tokamak server");
  const count = page.getByRole("status", { name: "Live thread count" });
  await expect(count).toHaveText(/\d+ live threads/);
  const initial = Number((await count.innerText()).split(" ")[0]);
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByRole("status", { name: "Live thread count" })).toHaveText(
    `${initial} live threads`,
  );
  await page
    .getByRole("navigation", { name: "Plugin views" })
    .getByRole("link", { name: "FixtureView", exact: true })
    .click();
  const fixture = page.getByRole("region", { name: "Integration fixture" });
  await expect(fixture.getByRole("heading", { name: /Fixture revision/ })).toBeVisible();
  await expect(fixture.getByRole("status", { name: "Fixture thread count" })).toHaveText(
    `Fixture live threads: ${initial}`,
  );
  const title = `Browser thread ${crypto.randomUUID()}`;
  await page.getByRole("textbox", { name: "New thread title" }).fill(title);
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await expect(count).toHaveText(`${initial + 1} live threads`);
  await expect(second.getByRole("status", { name: "Live thread count" })).toHaveText(
    `${initial + 1} live threads`,
  );
  await expect(second.getByRole("list", { name: "Threads" })).toContainText(title);
  await expect(fixture.getByRole("status", { name: "Fixture thread count" })).toHaveText(
    `Fixture live threads: ${initial + 1}`,
  );

  const sentinel = crypto.randomUUID();
  await page.evaluate((value) => {
    (window as unknown as { documentSentinel: string }).documentSentinel = value;
  }, sentinel);
  const source = `${process.env.TOKAMAK_FIXTURE_SOURCE}/src/client/api.tsx`;
  const revision = `Fixture revision ${crypto.randomUUID()}`;
  await writeFile(source, (await readFile(source, "utf8")).replace(/Fixture revision [^<]+/, revision));
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
  await expect(fixture.getByRole("heading", { name: revision, exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { documentSentinel: string }).documentSentinel),
  ).toBe(sentinel);
  await expect(fixture.getByRole("status", { name: "Fixture thread count" })).toHaveText(
    `Fixture live threads: ${initial + 1}`,
  );

  await page.getByRole("link", { name: "ThrowingView", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Plugin view error" })).toContainText(
    "Deliberate fixture failure",
  );
  await expect(connection).toHaveText("Connected to real Tokamak server");
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await expect(second.getByRole("status", { name: "Live thread count" })).toHaveText(
    `${initial + 2} live threads`,
  );
  await page.getByRole("link", { name: "FixtureView", exact: true }).click();
  await expect(fixture.getByRole("status", { name: "Fixture thread count" })).toHaveText(
    `Fixture live threads: ${initial + 2}`,
  );
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
  await expect(page.getByRole("status", { name: "Connection status" })).not.toHaveText(
    "Connected to real Tokamak server",
  );
});
