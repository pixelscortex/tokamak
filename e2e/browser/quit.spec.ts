import { expect, test } from "@playwright/test";
import { asDesktop } from "./desktop";

test("quitting without a blocker confirms without a dialog", async ({ context, page }) => {
  const desktop = await asDesktop(context);
  await page.goto("/p/integration-fixture");
  await expect(page.getByRole("button", { name: "Start fixture work" })).toBeVisible();

  await desktop.requestQuit();
  await expect.poll(() => desktop.quitAnswers).toEqual(["confirm"]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("cancel keeps fixture work running; stop and quit stops it and confirms", async ({ context, page }) => {
  let stoppedAtConfirm = false;
  const desktop = await asDesktop(context, {
    // Confirm shuts down the Runner, which unmounts the fixture view.
    beforeConfirm: async (page) => {
      stoppedAtConfirm = await page.getByText("Fixture work stopped").isVisible();
    },
  });
  await page.goto("/p/integration-fixture");
  await page.getByRole("button", { name: "Start fixture work" }).click();
  const running = page.getByText("Fixture work is running");
  const dialog = page.getByRole("dialog", { name: "Fixture is still working" });

  await desktop.requestQuit();
  await expect(dialog).toBeVisible();
  expect(desktop.quitAnswers).toEqual(["hold"]);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => desktop.quitAnswers).toEqual(["hold", "cancel"]);
  await expect(dialog).toHaveCount(0);
  await expect(running).toBeVisible();

  await desktop.requestQuit();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Stop and quit" }).click();
  await expect.poll(() => desktop.quitAnswers).toEqual(["hold", "cancel", "hold", "confirm"]);
  expect(stoppedAtConfirm).toBe(true);
});
