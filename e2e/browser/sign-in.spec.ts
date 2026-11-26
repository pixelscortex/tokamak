import { expect, test as base } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { startHostedFixture } from "../hosted-fixture";

const test = base.extend<{ shared: { url: string; ownerKey: string } }>({
  shared: async ({}, use) => {
    const server = await startHostedFixture({ port: 0, ownerKey: randomBytes(32).toString("hex") });
    try {
      await use(server);
    } finally {
      server.stop();
      expect(await server.exited).toBe(0);
    }
  },
});
const password = "password for browser acceptance";

test("the app-wide sign-in dialog draws the server form and remembers a device", async ({
  page,
  request,
  shared: { url, ownerKey },
}) => {
  const address = new URL(url).host;
  const methods = await request.get(`${url}/auth/methods`);
  expect(await methods.json()).toMatchObject({
    ownerSetup: true,
    methods: [{ id: "fixture-sign-in", name: "Password" }],
  });

  await page.goto("/p/integration-fixture");
  const status = page.getByRole("status", { name: "Connection status" });
  await expect(status).toHaveText("127.0.0.1:43123");
  await page.getByRole("button", { name: /^Server: This Mac/ }).click();
  await page.getByRole("menuitem", { name: "Add server…" }).click();
  await page.getByRole("textbox", { name: "Server address" }).fill(url);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Found the server")).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Username or email")).toBeVisible();
  await dialog.getByRole("button", { name: "Set up owner account" }).click();
  await dialog.getByLabel("Owner key").fill(ownerKey);
  const exchange = page.waitForResponse(`${url}/auth/owner`);
  await dialog.getByRole("button", { name: "Continue" }).click();
  const { key } = await (await exchange).json();
  expect(key).not.toBe(ownerKey);
  await dialog.getByLabel("Username", { exact: true }).fill("sam");
  await dialog.getByLabel("Email", { exact: true }).fill("sam@example.com");
  await dialog.getByLabel("Password", { exact: true }).fill(password);
  const setup = page.waitForRequest(`${url}/auth/owner/setup`);
  await dialog.getByRole("button", { name: "Create account" }).click();
  expect(await (await setup).headerValue("authorization")).toBe(`Bearer ${key}`);
  await expect(status).toHaveText(address);
  await page.evaluate(() => localStorage.clear());
  await page.goto(url);

  await dialog.getByLabel("Username or email").fill("sam@example.com");
  await dialog.getByLabel("Password", { exact: true }).fill("incorrect password");
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("The username, email, or password is incorrect.");
  await dialog.getByLabel("Password", { exact: true }).fill(password);
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(status).toHaveText(address);

  await page.reload();
  await expect(status).toHaveText(address);
  await expect(dialog).toHaveCount(0);
});

test("the sign-in dialog uses field names and input types from the provider", async ({
  page,
  shared: { url },
}) => {
  await page.route(`${url}/auth/methods`, (route) =>
    route.fulfill({
      json: {
        methods: [{ id: "passcode", name: "Passcode", form: { organization: "text", passcode: "password" } }],
        ownerSetup: false,
      },
    }),
  );
  await page.route(`${url}/auth/sign-in`, (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      method: "passcode",
      fields: { organization: "Test group", passcode: "secret" },
    });
    return route.fulfill({ status: 401, json: { failed: true, kind: "WrongPasscode", data: null } });
  });
  await page.goto(url);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Use owner key" }).click();
  await expect(dialog.getByText("The owner uses the owner key to sign in to this server.")).toBeVisible();
  await dialog.getByRole("button", { name: "Back" }).click();
  await dialog.getByLabel("Organization").fill("Test group");
  const passcode = dialog.getByLabel("Passcode");
  await expect(passcode).toHaveAttribute("type", "password");
  await passcode.fill("secret");
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Couldn’t sign in. Try again.");
});

test("owner setup uses the optional provider form", async ({ page, shared: { url, ownerKey } }) => {
  const provider = {
    id: "organization",
    name: "Organization",
    form: { account: "text", passcode: "password" },
    setupOwnerForm: { adminEmail: "email", enrollmentCode: "password" },
  };
  await page.route(`${url}/auth/methods`, (route) =>
    route.fulfill({ json: { methods: [provider], ownerSetup: true } }),
  );
  await page.route(`${url}/auth/owner`, (route) =>
    route.fulfill({
      json: { key: "recovery-device", setupMethods: [provider] },
    }),
  );
  await page.route(`${url}/auth/owner/setup`, (route) => {
    expect(route.request().postDataJSON()).toEqual({
      method: provider.id,
      fields: { adminEmail: "sam@example.com", enrollmentCode: "enroll" },
    });
    return route.fulfill({ status: 400, json: { failed: true, kind: "InvalidFields", data: null } });
  });
  await page.goto(url);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Set up owner account" }).click();
  await dialog.getByLabel("Owner key").fill(ownerKey);
  await dialog.getByRole("button", { name: "Continue" }).click();
  const email = dialog.getByLabel("Admin email");
  await expect(email).toHaveAttribute("type", "email");
  await email.fill("sam@example.com");
  await dialog.getByLabel("Enrollment code").fill("enroll");
  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Couldn’t sign in. Try again.");
});

test("Members recovers a lost Add response, shows role changes live, and removes access", async ({
  page,
  request,
  browser,
  shared: { url, ownerKey },
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "Set up owner account" }).click();
  await page.getByLabel("Owner key").fill(ownerKey);
  const exchange = page.waitForResponse(`${url}/auth/owner`);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const { key } = await (await exchange).json();
  await page.getByRole("button", { name: "Continue without setup" }).click();
  await expect(page.getByRole("status", { name: "Connection status" })).toHaveText(new URL(url).host);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Members" }).click();

  const members = page.getByRole("region", { name: "Members" });
  await expect(members.getByRole("listitem").filter({ hasText: "Owner" })).toBeVisible();
  await page.route(
    `${url}/members`,
    async (route) => {
      // Commit the Add on the server, then lose the response from the window's perspective.
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("timedout");
    },
    { times: 1 },
  );
  await members.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Username", { exact: true }).fill("Alice");
  await dialog.getByLabel("Email", { exact: true }).fill("alice@example.com");
  await dialog.getByLabel("Temporary password", { exact: true }).fill("temporary password for Alice");
  await dialog.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Couldn’t confirm that the member was added.");
  const refresh = page.waitForRequest(`${url}/members/live`);
  await dialog.getByRole("button", { name: "Add member", exact: true }).click();
  await refresh;
  await expect(dialog.getByRole("alert")).toContainText("check the updated member list");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  const alice = members.getByRole("listitem").filter({ hasText: "Alice" });
  await expect(alice).toHaveCount(1);
  await expect(alice.getByText("Member", { exact: true })).toBeVisible();

  const headers = { Authorization: `Bearer ${key}` };
  const roster = await request.get(`${url}/members`, { headers });
  const { id } = (await roster.json()).find(({ name }: { name: string }) => name === "Alice");
  const updated = await request.post(`${url}/members/${id}/role`, {
    headers,
    data: { role: "admin" },
  });
  expect(updated.ok()).toBe(true);
  await expect(alice.getByText("Admin", { exact: true })).toBeVisible();
  await alice.getByRole("button", { name: "Actions for Alice" }).click();
  await page.getByRole("menuitem", { name: "Reset password" }).click();
  await expect(dialog).toHaveAccessibleDescription(/All their devices will be signed out/);
  await dialog.getByLabel("Temporary password").fill("replacement temporary password");
  await dialog.getByRole("button", { name: "Reset password" }).click();
  await expect(dialog).toHaveCount(0);

  const context = await browser.newContext();
  try {
    const client = await context.newPage();
    await client.goto(url);
    const credentials = client.getByRole("dialog");
    await credentials.getByLabel("Username or email").fill("ALICE@example.com");
    await credentials.getByLabel("Password", { exact: true }).fill("replacement temporary password");
    await credentials.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(credentials).toHaveAccessibleName("Choose a new password");
    await credentials.getByLabel("New password", { exact: true }).fill("Alice's private password");
    await credentials.getByLabel("Confirm new password", { exact: true }).fill("Alice's private password");
    await credentials.getByRole("button", { name: "Set password", exact: true }).click();
    await expect(client.getByRole("status", { name: "Connection status" })).toHaveText(new URL(url).host);

    await alice.getByRole("button", { name: "Actions for Alice" }).click();
    await page.getByRole("menuitem", { name: "Remove member" }).click();
    await dialog.getByRole("button", { name: "Remove member" }).click();
    await expect(alice).toHaveCount(0);
    await expect(client.getByText("This device was signed out.")).toBeVisible();
  } finally {
    await context.close();
  }
});
