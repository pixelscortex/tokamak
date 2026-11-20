import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = fileURLToPath(new URL("../../packages/cli/src/main.ts", import.meta.url));

test("sharing and removing a plugin leaves the open view mounted", async ({ page, context, request }) => {
  const source = await mkdtemp(join(tmpdir(), "tokamak-browser-plugin-"));
  const server = "http://127.0.0.1:43123";
  const id = "browser-shared";
  const url = `${server}/plugins/${id}`;
  const headers = { authorization: `Bearer ${process.env.VITE_TOKAMAK_TOKEN}` };
  let installed = false;
  try {
    await mkdir(join(source, "src/client"), { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ name: id, version: "1.0.0" }));
    await writeFile(
      join(source, "plugin.ts"),
      `import { definePlugin } from "@tokamak/sdk";
export default definePlugin({ id: "${id}", version: "1.0.0" });`,
    );
    await writeFile(
      join(source, "src/client/api.tsx"),
      `import { view } from "@tokamak/sdk/client";
export const SharedView = view({ route: "/detail" }, () => <p>Shared plugin is running</p>);`,
    );
    const { stdout } = await promisify(execFile)("proto", [
      "run",
      "bun",
      "--",
      `--cwd=${source}`,
      cli,
      "plugin",
      "pack",
      source,
      "--json",
    ]);
    const { path, buildId } = JSON.parse(stdout);
    await page.goto("/p/integration-fixture");
    const fixture = page.getByRole("region", { name: "Integration fixture" });
    await expect(fixture).toBeVisible();
    const original = (await fixture.elementHandle())!;
    const views = page.getByRole("navigation", { name: "Views" });
    const shared = views.getByRole("link", { name: "SharedView" });
    await expect(shared).toHaveCount(0);
    const sharedWindow = await context.newPage();
    await sharedWindow.goto("/p/integration-fixture");
    await expect(sharedWindow.getByRole("region", { name: "Integration fixture" })).toBeVisible();

    const upload = await request.put(`${url}/package`, {
      headers: { ...headers, "x-tokamak-build-id": buildId },
      data: await readFile(path),
    });
    expect(upload.ok(), await upload.text()).toBe(true);
    installed = true;
    await expect(shared).toBeVisible();
    expect(await original.evaluate((node) => node.isConnected)).toBe(true);

    await sharedWindow.getByRole("link", { name: "SharedView", exact: true }).click();
    const sharedView = sharedWindow.getByText("Shared plugin is running");
    await expect(sharedWindow).toHaveURL(/\/p\/browser-shared\/detail$/);
    await expect(sharedView).toBeVisible();
    const removal = await request.delete(url, { headers });
    expect(removal.ok(), await removal.text()).toBe(true);
    installed = false;
    await expect(shared).toHaveCount(0);
    await expect(sharedView).toHaveCount(0);
    await expect(sharedWindow).toHaveURL(/\/p\/chat$/);
    await expect(sharedWindow.getByRole("textbox", { name: "Message" })).toBeVisible();
    await expect(sharedWindow.getByRole("navigation", { name: "Open pages" })).toBeVisible();
    const rail = sharedWindow.getByRole("navigation", { name: "Views" });
    await expect(rail).toBeVisible();
    await rail.getByRole("link", { name: "FixtureView", exact: true }).click();
    await expect(sharedWindow.getByRole("region", { name: "Integration fixture" })).toBeVisible();
    expect(await original.evaluate((node) => node.isConnected)).toBe(true);
  } finally {
    if (installed) await request.delete(url, { headers });
    await rm(source, { recursive: true, force: true });
  }
});
