import { installBasicAuth, selectedRuntime, signInMember } from "../../../e2e/fake-agent/harness.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { authCaller, createApi, TokamakClient, WebSocketTransport } from "../../sdk/src/index";
import { within } from "./within.ts";

const binary = process.argv[2];
assert.ok(binary, "Expected the path to the tokamak-server binary");

const timeoutMs = 20_000;
const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const ownerToken = "auth-acceptance-owner-token-for-test";
const appOrigin = "tauri://localhost";
const api = createApi("auth-test");

async function buildPlugin(root, broken = false) {
  const plugin = join(root, "plugin");
  await cp(new URL("./fixtures/auth/", import.meta.url), plugin, { recursive: true });
  if (broken) {
    await writeFile(
      join(plugin, "src/server/identity.ts"),
      `import { query } from "@tokamak/sdk";
export const read = query({ handler: () => "unreachable" });
throw new Error("Broken plugin");`,
    );
  }
  await symlink(join(workspace, "app/node_modules"), join(plugin, "node_modules"), "dir");
  await writeFile(
    join(plugin, "src/server/tsconfig.json"),
    JSON.stringify({ extends: join(workspace, "tsconfig.json") }),
  );
  const result = Bun.spawnSync([process.execPath, join(workspace, "packages/build/src/build.ts"), plugin], {
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(result.exitCode, 0, "auth probe plugin build");
  return plugin;
}

async function serve(binary, root, plugin, shared, check, extraEnv = {}) {
  const dir = join(root, shared ? "shared" : "local");
  await mkdir(dir, { recursive: true });
  const args = ["--plugins", plugin, "--data", join(dir, "store"), "--listen", "127.0.0.1:0"];
  if (shared) {
    await writeFile(join(dir, "index.html"), "Auth acceptance");
    args.push("--web", dir);
  }
  const child = Bun.spawn([binary, ...args], {
    env: {
      ...process.env,
      ...extraEnv,
      TOKAMAK_ACCESS_TOKEN: ownerToken,
      TOKAMAK_OWNER_NAME: "Test Owner",
      TOKAMAK_ALLOWED_ORIGINS: appOrigin,
      ...(process.platform === "linux" && !shared ? { PATH: "" } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const lines = createInterface({ input: Readable.fromWeb(child.stdout) });
  let failed = false;
  try {
    const address = await within(
      new Promise((resolve, reject) => {
        lines.on("line", (line) => {
          const match = line.match(/Tokamak listening on (ws:\/\/127\.0\.0\.1:\d+\/ws)/);
          if (match) resolve(match[1]);
        });
        lines.on("close", () => reject(new Error("Server exited before readiness")));
      }),
      "server readiness",
      timeoutMs,
    );
    await within(check(address, dir), "auth scenario", timeoutMs);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    child.kill("SIGTERM");
    try {
      assert.equal(await within(child.exited, "server shutdown", timeoutMs), 0);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      lines.close();
      if (failed) console.error(await stderr);
    }
  }
  return stderr;
}

async function withClient(address, token, run) {
  const url = new URL(address);
  const socket = new WebSocket(url, token ? ["tokamak", `tokamak.bearer.${token}`] : undefined);
  try {
    await within(
      new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
      }),
      "WebSocket connection",
      timeoutMs,
    );
    assert.equal(socket.protocol, token ? "tokamak" : "");
    const transport = new WebSocketTransport(socket);
    try {
      await run(new TokamakClient(transport), socket, transport);
    } finally {
      transport.close();
    }
  } finally {
    socket.close();
  }
}

async function admin(address, path, body, token = ownerToken) {
  const url = new URL(path, address.replace(/^ws:/, "http:"));
  return fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function withBlockedMemberStore(dir, check) {
  const membersFile = join(dir, "members.json");
  const backup = `${membersFile}.backup`;
  await rename(membersFile, backup);
  // A directory blocks replacement of the member store without affecting the provider's store.
  await mkdir(membersFile);
  try {
    await check();
  } finally {
    await rmdir(membersFile);
    await rename(backup, membersFile);
  }
}

function deviceUpdates(address, token, check) {
  return snapshots(address, token, "/devices/live", check);
}

async function snapshots(address, token, path, check) {
  const response = await appRequest(address, path, token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), appOrigin);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  async function next() {
    while (true) {
      const end = pending.indexOf("\n\n");
      if (end >= 0) {
        const event = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = event.split("\n").find((line) => line.startsWith("data:"));
        if (data) return JSON.parse(data.slice(5));
        continue;
      }
      const chunk = await reader.read();
      assert.ok(!chunk.done, "device list stream closed");
      pending += chunk.value;
    }
  }
  try {
    await check(next);
  } finally {
    await reader.cancel();
  }
}

function appRequest(address, path, token, method = "GET") {
  const url = new URL(path, address.replace(/^ws:/, "http:"));
  const headers = { origin: appOrigin, authorization: `Bearer ${token}` };
  return fetch(url, { method, headers });
}

async function verifyBearerRequest(address, path, method, key) {
  const url = new URL(path, address.replace(/^ws:/, "http:"));
  const preflightHeaders = {
    origin: appOrigin,
    "access-control-request-method": method,
    "access-control-request-headers": "authorization",
  };
  const preflight = await fetch(url, { method: "OPTIONS", headers: preflightHeaders });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), appOrigin);
  assert.equal(preflight.headers.get("access-control-allow-methods"), method);
  assert.equal(preflight.headers.get("access-control-allow-headers"), "authorization");
  const refused = await fetch(url, {
    method: "OPTIONS",
    headers: { ...preflightHeaders, origin: "https://untrusted.example" },
  });
  assert.equal(refused.status, 403);

  url.searchParams.set("token", key);
  const queryOnly = await fetch(url, { method, headers: { origin: appOrigin } });
  assert.equal(queryOnly.status, 401);
}

function closed(socket) {
  return new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
}

function assertRefused(address, key) {
  return assert.rejects(
    withClient(address, key, () => assert.fail("Revoked key connected")),
    /WebSocket failed/,
  );
}

const sha256 = (key) => createHash("sha256").update(key).digest("hex");

async function verifyDevicePermissions(address, device, firstSocket, ownerDevice, ownerDeviceKey) {
  const { key: token } = await signInMember(address, ownerToken, "Bob");
  await withClient(address, token, async (bob, bobSocket) => {
    const caller = await bob.query(authCaller, {});
    const target = `/devices/${encodeURIComponent(device.id)}/revoke`;
    await deviceUpdates(address, token, async (next) => {
      assert.deepEqual(
        (await next()).map((entry) => entry.id),
        [caller.device.id],
      );
      assert.equal((await admin(address, target, {}, token)).status, 403);
      assert.equal((await admin(address, `/members/${caller.user.id}/role`, { role: "admin" })).status, 200);
      const manageable = await next();
      assert.ok(manageable.some((entry) => entry.id === device.id));
      assert.ok(manageable.some((entry) => entry.id === caller.device.id && entry.current));
      assert.ok(
        manageable.every((entry) => entry.member.role === "member" || entry.member.id === caller.user.id),
      );

      assert.equal((await admin(address, "/devices/device%3Aowner/revoke", {}, token)).status, 404);
      const aliceOut = closed(firstSocket);
      assert.equal((await admin(address, target, {}, token)).status, 200);
      assert.equal((await within(aliceOut, "admin signs out a member's device", 2_000)).code, 4001);
    });
    await withClient(address, ownerDeviceKey, async (owner, ownerSocket) => {
      assert.equal((await owner.query(authCaller, {})).device.id, ownerDevice.id);
      const ownerTarget = `/devices/${ownerDevice.id}/revoke`;
      assert.equal((await admin(address, ownerTarget, {}, token)).status, 403);
      assert.equal((await owner.query(authCaller, {})).device.id, ownerDevice.id);
      const ownerOut = closed(ownerSocket);
      assert.equal((await admin(address, ownerTarget, {})).status, 200);
      assert.equal((await within(ownerOut, "owner signs out an owner's device", 2_000)).code, 4001);
    });
    const bobOut = closed(bobSocket);
    assert.equal(
      (await admin(address, `/devices/${encodeURIComponent(caller.device.id)}/revoke`, {}, token)).status,
      200,
    );
    assert.equal((await within(bobOut, "admin signs out their own device", 2_000)).code, 4001);
  });
}

const root = await mkdtemp(join(tmpdir(), "tokamak-auth-"));
try {
  const plugin = await buildPlugin(root);
  if (process.argv.includes("--members")) await verifyMembers(plugin);
  else if (process.argv.includes("--sign-in")) await verifySignIn(plugin);
  else await verifyIdentity(plugin);
} finally {
  await rm(root, { recursive: true });
}

async function verifyMembers(probe) {
  const plugins = join(root, "member-plugins");
  await mkdir(plugins);
  const basicAuth = join(plugins, "basic-auth");
  await copyAndBuildAuth(basicAuth);
  await cp(probe, join(plugins, "auth-test"), {
    recursive: true,
    filter: (path) => !path.split("/").includes("node_modules"),
  });
  const method = "basic-auth";
  const alice = { username: "Alice", email: "alice@example.com", password: "first temporary password" };
  const bob = { username: "Bob", email: "bob@example.com", password: "Bob's temporary password" };
  const alicePermanent = "Alice's own password";
  const bobPrevious = "Bob's previous password";
  const bobReset = "Bob's replacement temporary password";
  const bobPermanent = "Bob's own password";
  const add = (address, fields, token) => admin(address, "/members", { method, fields }, token);
  const signIn = (address, usernameOrEmail, password, newPassword) =>
    admin(
      address,
      "/auth/sign-in",
      {
        method,
        fields: { usernameOrEmail, password },
        deviceName: "Acceptance device",
        newPassword,
      },
      "",
    );
  const writeDraft = "tokamak:writeWindowState";
  const readDraft = "tokamak:readWindowState";
  const state = { plugin: "auth-test", key: "member-draft" };
  let removedMember;
  let aliceKey;
  let bobKey;
  let replacedBobKeys;
  let savedProfiles;
  const logs = await serve(binary, root, plugins, true, async (address, dir) => {
    await verifyBearerRequest(address, "/members/live", "GET", ownerToken);
    await snapshots(address, ownerToken, "/members/live", async (next) => {
      assert.deepEqual(
        (await next()).members.map((user) => user.role),
        ["owner"],
      );
      assert.equal((await add(address, alice, "")).status, 401, "no self-sign-up");
      await withBlockedMemberStore(dir, async () => {
        const failed = await add(address, alice);
        assert.equal(failed.status, 503);
        assert.equal((await failed.json()).kind, "MemberManagementUnavailable");
      });
      const added = await add(address, alice);
      assert.equal(added.status, 200, `Retry after the member store recovers: ${await added.clone().text()}`);
      const user = await added.json();
      const target = `/members/${user.id}`;
      assert.deepEqual(user, { id: user.id, name: "Alice", role: "member" });
      assert.ok(user.id);
      assert.ok((await next()).members.some((row) => row.id === user.id && row.role === "member"));
      const duplicate = await add(address, { ...bob, email: "  ALICE@example.com " });
      assert.equal(duplicate.status, 400);
      assert.equal((await duplicate.json()).kind, "LoginTaken");
      assert.equal((await add(address, { ...bob, username: "aLiCe" })).status, 400);

      const pending = await signIn(address, alice.email, alice.password);
      assert.equal(pending.status, 403);
      assert.deepEqual(await pending.json(), { failed: true, kind: "PasswordChangeRequired", data: null });
      assert.equal(
        (await admin(address, `${target}/reset-password`, { password: "bypass" }, "")).status,
        401,
      );
      const unchanged = await signIn(address, alice.email, alice.password, alice.password);
      assert.equal((await unchanged.json()).kind, "PasswordUnchanged");
      const changed = await signIn(address, alice.email, alice.password, alicePermanent);
      assert.equal(changed.status, 200, await changed.clone().text());
      aliceKey = (await changed.json()).key;
      assert.equal((await signIn(address, alice.username, alice.password)).status, 401);
      const issued = await signIn(address, alice.username, alicePermanent);
      assert.equal(issued.status, 200);
      const secondKey = (await issued.json()).key;

      await withClient(address, aliceKey, async (first, firstSocket, window) => {
        assert.deepEqual((await first.query(authCaller, {})).user, user);
        await window.mutation(writeDraft, { ...state, value: "Alice's draft" });
        assert.deepEqual(await window.query(readDraft, state), { value: "Alice's draft" });
        assert.equal((await add(address, bob, aliceKey)).status, 403);
        await assert.rejects(
          first.action(createApi("basic-auth").accounts.createAccount, { memberId: user.id, fields: bob }),
          /unknown (?:action|function)/i,
        );
        assert.equal((await admin(address, `${target}/role`, { role: "admin" }, aliceKey)).status, 403);
        assert.equal((await admin(address, `${target}/role`, { role: "owner" })).status, 400);
        assert.equal((await admin(address, `${target}/role`, { role: "admin" })).status, 200);
        assert.equal((await next()).members.find((row) => row.id === user.id).role, "admin");
        assert.equal((await first.query(authCaller, {})).user.role, "admin");
        assert.equal(
          (await admin(address, "/members/owner/reset-password", { password: "bad idea" }, aliceKey)).status,
          403,
        );
        assert.equal((await admin(address, "/members/owner/revoke", {}, aliceKey)).status, 403);

        const bobAdded = await add(address, bob, aliceKey);
        assert.equal(bobAdded.status, 200, await bobAdded.clone().text());
        const bobUser = await bobAdded.json();
        assert.equal(bobUser.role, "member");
        await next();
        assert.equal(
          (await admin(address, `/members/${bobUser.id}/role`, { role: "admin" }, aliceKey)).status,
          403,
        );
        const firstDevice = await signIn(address, bob.email, bob.password, bobPrevious);
        assert.equal(firstDevice.status, 200);
        const secondDevice = await signIn(address, bob.username, bobPrevious);
        assert.equal(secondDevice.status, 200);
        const { key: firstBobKey } = await firstDevice.json();
        const { key: secondBobKey } = await secondDevice.json();
        replacedBobKeys = [firstBobKey, secondBobKey];
        const resetBob = () =>
          admin(address, `/members/${bobUser.id}/reset-password`, { password: bobReset }, aliceKey);
        await withClient(address, firstBobKey, async (firstBob, firstBobSocket) => {
          await withClient(address, secondBobKey, async (secondBob, secondBobSocket) => {
            await withBlockedMemberStore(dir, async () => {
              const failed = await resetBob();
              assert.equal(failed.status, 503);
              assert.equal((await failed.json()).kind, "MemberManagementUnavailable");
            });
            assert.deepEqual((await firstBob.query(authCaller, {})).user, bobUser);
            assert.deepEqual((await secondBob.query(authCaller, {})).user, bobUser);
            const disconnected = Promise.all([closed(firstBobSocket), closed(secondBobSocket)]);
            const response = await resetBob();
            assert.equal(response.status, 204, await response.clone().text());
            for (const socket of await within(disconnected, "both reset devices close", 2_000)) {
              assert.equal(socket.code, 4001);
            }
          });
        });
        await assertRefused(address, firstBobKey);
        await assertRefused(address, secondBobKey);
        assert.equal((await signIn(address, bob.email, bobPrevious)).status, 401);
        const bobPending = await signIn(address, bob.email, bobReset);
        assert.equal(bobPending.status, 403);
        assert.equal((await bobPending.json()).kind, "PasswordChangeRequired");
        const bobSignedIn = await signIn(address, bob.username, bobReset, bobPermanent);
        assert.equal(bobSignedIn.status, 200, await bobSignedIn.clone().text());
        bobKey = (await bobSignedIn.json()).key;
        await withClient(address, bobKey, async (client, _socket, window) => {
          assert.deepEqual((await client.query(authCaller, {})).user, bobUser);
          await window.mutation(writeDraft, { ...state, value: "Bob's draft" });
        });

        assert.equal((await admin(address, `${target}/role`, { role: "member" })).status, 200);
        assert.equal((await next()).members.find((row) => row.id === user.id).role, "member");
        assert.equal((await first.query(authCaller, {})).user.role, "member");
        assert.equal(
          (await admin(address, `/members/${bobUser.id}/reset-password`, { password: bobReset }, aliceKey))
            .status,
          403,
        );
        savedProfiles = await Bun.file(join(dir, "members.json")).json();
        removedMember = user.id;
        await withClient(address, secondKey, async (second, secondSocket) => {
          assert.deepEqual((await second.query(authCaller, {})).user, user);
          const disconnected = Promise.all([closed(firstSocket), closed(secondSocket)]);
          assert.equal((await admin(address, `${target}/revoke`)).status, 200);
          assert.equal((await admin(address, `${target}/revoke`)).status, 200);
          for (const socket of await within(disconnected, "both removed devices close", 2_000)) {
            assert.equal(socket.code, 4001);
          }
          assert.ok((await next()).members.every((row) => row.id !== user.id));
          await assertRefused(address, aliceKey);
          await assertRefused(address, secondKey);
          assert.equal((await signIn(address, alice.email, alicePermanent)).status, 401);
          await withClient(address, ownerToken, async (owner) => {
            const events = await owner.query(api.members.list, { member: user.id });
            assert.deepEqual(events.sort(), ["added", "removed"]);
          });
          // Removing the account frees the login without granting new devices to the old member.
          const readded = await add(address, alice);
          assert.equal(readded.status, 200, await readded.clone().text());
          assert.notEqual((await readded.json()).id, user.id);
        });
      });
    });
  });
  for (const secret of [
    alice.password,
    bob.password,
    bobPrevious,
    bobReset,
    alicePermanent,
    bobPermanent,
    aliceKey,
    bobKey,
    ...replacedBobKeys,
  ])
    assert.ok(!logs.includes(secret));
  const membersFile = join(root, "shared", "members.json");
  const profiles = await Bun.file(membersFile).json();
  const revoked = savedProfiles.find((profile) => profile.id === removedMember);
  await writeFile(
    membersFile,
    JSON.stringify(profiles.map((profile) => (profile.id === removedMember ? revoked : profile))),
  );
  // Restoring only the profile allows reading through the real window interface
  // to prove cleanup persisted and did not erase a different member's kept state.
  await serve(binary, root, plugins, true, async (address) => {
    for (const key of replacedBobKeys) await assertRefused(address, key);
    await withClient(address, aliceKey, async (_client, _socket, window) => {
      assert.equal(await window.query(readDraft, state), null);
    });
    await withClient(address, bobKey, async (_client, _socket, window) => {
      assert.deepEqual(await window.query(readDraft, state), { value: "Bob's draft" });
    });
  });
}

async function verifySignIn(probe) {
  const request = (address, path, body, token, from) =>
    fetch(new URL(path, address.replace(/^ws:/, "http:")), {
      method: body ? "POST" : "GET",
      headers: {
        origin: appOrigin,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(from ? { "x-forwarded-for": from } : {}),
      },
      body: body && JSON.stringify(body),
    });
  const discovery = async (address, expected) => {
    const response = await request(address, "/auth/methods");
    assert.equal(response.status, 200, "sign-in methods are available before a session");
    assert.equal(response.headers.get("access-control-allow-origin"), appOrigin);
    assert.deepEqual(await response.json(), expected);
  };
  const fields = { username: "Sam", email: "sam@example.com", password: "first password (acceptance)" };
  const setup = { method: "basic-auth", fields };
  const owner = { deviceName: "First client" };
  const provider = {
    id: "basic-auth",
    name: "Password",
    form: { usernameOrEmail: "text", password: "password" },
    setupOwnerForm: { username: "text", email: "email", password: "password" },
    createAccountForm: { username: "text", email: "email", password: "password" },
  };
  await serve(binary, root, probe, true, async (address) => {
    await discovery(address, { methods: [], ownerSetup: false });
    const recovery = await request(address, "/auth/owner", { ...owner, setup: true }, ownerToken);
    assert.equal(recovery.status, 200);
    const { key, device, setupMethods } = await recovery.json();
    assert.deepEqual(setupMethods, []);
    assert.notEqual(key, ownerToken);
    await withClient(address, key, async (client, socket) => {
      assert.deepEqual((await client.query(authCaller, {})).device, device);
      const signedOut = closed(socket);
      assert.equal((await admin(address, `/devices/${device.id}/revoke`, {}, key)).status, 200);
      assert.equal((await within(signedOut, "owner recovery device revocation", 2_000)).code, 4001);
    });
    await assertRefused(address, key);
  });
  const plugins = join(root, "sign-in-plugins");
  const basicAuth = join(plugins, "basic-auth");
  await mkdir(plugins);
  const legacy = Bun.password.hashSync(fields.password, {
    algorithm: "argon2id",
    memoryCost: 8192,
    timeCost: 1,
  });
  const modernizeFixture = await copyAndBuildAuth(basicAuth, legacy);
  const signIn = (address, usernameOrEmail, password = fields.password, from) =>
    request(
      address,
      "/auth/sign-in",
      {
        method: "basic-auth",
        fields: { usernameOrEmail, password },
        deviceName: "Second client",
      },
      undefined,
      from,
    );
  let firstKey, secondKey, firstDevice;
  const logs = await serve(
    binary,
    root,
    plugins,
    true,
    async (address, dir) => {
      await discovery(address, { methods: [provider], ownerSetup: true });
      assert.equal((await request(address, "/auth/owner/setup", setup)).status, 401);
      assert.equal((await request(address, "/auth/owner", owner, "wrong-key")).status, 401);
      assert.equal((await request(address, "/auth/owner/setup", setup, ownerToken)).status, 403);
      const ordinary = await request(address, "/auth/owner", owner, ownerToken);
      const { key: ordinaryKey } = await ordinary.json();
      assert.equal((await request(address, "/auth/owner/setup", setup, ordinaryKey)).status, 403);
      const response = await request(address, "/auth/owner", { ...owner, setup: true }, ownerToken);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "no-store");
      const { key: recoveryKey, device: recoveryDevice, setupMethods } = await response.json();
      firstKey = recoveryKey;
      firstDevice = recoveryDevice;
      assert.notEqual(firstKey, ownerToken);
      assert.deepEqual(setupMethods, [provider]);
      assert.equal(firstDevice.name, "First client");
      assert.equal(
        (await request(address, "/auth/owner/setup", { method: setup.method, fields: {} }, firstKey)).status,
        400,
      );
      assert.equal((await request(address, "/auth/owner/setup", setup, firstKey)).status, 204);
      const members = await Bun.file(join(dir, "members.json")).text();
      assert.ok(members.includes(sha256(firstKey)) && !members.includes(firstKey));
      await withClient(address, firstKey, async (first) => {
        assert.deepEqual(await first.query(authCaller, {}), {
          user: { id: "owner", name: "Sam", role: "owner" },
          device: firstDevice,
        });
        await assert.rejects(
          first.action(createApi("basic-auth").accounts.createOwner, fields),
          /unknown (?:action|function)/i,
        );
      });
      const denied = await signIn(address, "Sam", "wrong password");
      assert.equal(denied.status, 401);
      assert.deepEqual(await denied.json(), { failed: true, kind: "WrongPassword", data: null });
      const email = await signIn(address, "SAM@example.com");
      assert.equal(email.status, 200, await email.clone().text());
      const { key, device } = await email.json();
      secondKey = key;
      assert.notEqual(firstKey, secondKey);
      assert.notEqual(firstDevice.id, device.id);
      assert.equal(device.name, "Second client");
      assert.equal((await signIn(address, "sam")).status, 200);
      await withClient(address, secondKey, async (client) => {
        assert.equal((await client.query(authCaller, {})).device.id, device.id);
      });
      for (const login of ["SAM", " sam ", "sam"]) {
        assert.equal((await signIn(address, login, "wrong password")).status, 401);
      }
      const slowed = await signIn(address, "SAM");
      assert.equal(slowed.status, 429, "repeated failures slow down the same normalized login");
      assert.equal((await slowed.json()).kind, "SignInThrottled");
      assert.ok(Number(slowed.headers.get("retry-after")) > 0);
      assert.equal((await signIn(address, fields.email)).status, 200, "another login is still admitted");
      assert.equal(
        (await signIn(address, "sam", fields.password, "203.0.113.4")).status,
        200,
        "one address cannot lock out another address using the same login",
      );
      for (const login of ["nobody", "someone-else"]) {
        assert.equal((await signIn(address, login, "wrong password")).status, 401);
      }
      assert.equal(
        (await signIn(address, fields.email)).status,
        429,
        "rotating login names does not bypass address backoff",
      );
      assert.equal(
        (await signIn(address, fields.email, fields.password, "203.0.113.4")).status,
        200,
        "an independent address can still sign in",
      );
      assert.equal(
        (await signIn(address, fields.email, fields.password, "203.0.113.4, 203.0.113.9")).status,
        200,
        "both configured proxies are skipped",
      );
      for (let i = 0; i < 3; i++) {
        assert.equal((await signIn(address, fields.email, "wrong password", "203.0.113.7")).status, 401);
      }
      assert.equal(
        (await signIn(address, fields.email, fields.password, "203.0.113.8, 203.0.113.7, 203.0.113.9"))
          .status,
        429,
        "the first untrusted hop keeps its sign-in backoff",
      );
      assert.equal(
        (await signIn(address, fields.email, fields.password, "127.0.0.1, 127.0.0.2, 203.0.113.9")).status,
        200,
        "an untrusted hop stops the walk",
      );
      assert.equal((await request(address, "/auth/owner/setup", setup, firstKey)).status, 403);
      assert.equal((await admin(address, "/members/owner/devices", { name: "Bypass" })).status, 404);
    },
    { TOKAMAK_TRUSTED_PROXY: "127.0.0.1, 203.0.113.9" },
  );
  assert.ok(!logs.includes(fields.password) && !logs.includes(firstKey) && !logs.includes(secondKey));

  const store = join(root, "shared", "store");
  const files = (await readdir(store, { recursive: true, withFileTypes: true })).filter((entry) =>
    entry.isFile(),
  );
  const bytes = await Promise.all(files.map((entry) => readFile(join(entry.parentPath, entry.name))));
  assert.ok(
    !bytes.some((file) => file.includes(fields.password)),
    "durable credential bytes omit the password",
  );
  assert.ok(
    bytes.some((file) => file.includes("$argon2id$v=19$m=19456,t=2,p=1$")),
    "signing in with a historical hash stores the current settings",
  );
  await modernizeFixture();
  await serve(binary, root, plugins, true, async (address) => {
    assert.equal((await signIn(address, "sam")).status, 200, "password survives restart");
  });
  const peer = join(plugins, "auth-test");
  await cp(probe, peer, {
    recursive: true,
    filter: (path) => !path.split("/").includes("node_modules"),
  });
  await symlink(join(workspace, "app/node_modules"), join(peer, "node_modules"), "dir");
  await writeFile(join(peer, "src/server/api.ts"), 'export { read } from "./identity";');
  buildDirectory(peer);
  const alternate = join(plugins, "alternate-auth");
  await mkdir(join(alternate, "src/server"), { recursive: true });
  await symlink(join(workspace, "app/node_modules"), join(alternate, "node_modules"), "dir");
  await writeFile(join(alternate, "package.json"), '{"name":"alternate-auth","version":"1.0.0"}');
  await writeFile(
    join(alternate, "plugin.ts"),
    `
    import { definePlugin } from "@tokamak/sdk";
    export default definePlugin({ id: "alternate-auth", version: "1.0.0", depends: ["auth", "auth-test"] });
  `,
  );
  await writeFile(
    join(alternate, "src/server/tsconfig.json"),
    JSON.stringify({ extends: join(workspace, "tsconfig.json") }),
  );
  const alternateMethod = `
    import type {} from "@tokamak/sdk/web";
    import { action, createApi, fail, internalAction, provide, query, v, type FunctionReference } from "@tokamak/sdk";
    type ReadRef = FunctionReference<"query", Record<string, never>, unknown>;
    import * as auth from "plugin:auth/contracts";
    export const exposed = query({ handler: () => "public" });
    export const alive = action({
      async handler() {
        await new Promise((resolve) => setTimeout(resolve, 5500));
        return "alive";
      },
    });
    const signIn = internalAction({
      args: { passcode: v.string() },
      async handler(ctx, { passcode }) {
        if (passcode === "hang") await new Promise(() => {});
        if (passcode === "spin") while (true) {}
        try { void ctx.auth.user; return fail("UnexpectedCaller", null); } catch {}
        if (passcode === "own" || passcode === "peer") {
          try {
            await ctx.runQuery(passcode === "own"
              ? createApi<{ method: { exposed: ReadRef } }>("alternate-auth").method.exposed
              : createApi<{ identity: { read: ReadRef } }>("auth-test").identity.read, {});
            return fail("UnexpectedAccess", null);
          } catch (error) {
            return fail(String(error).includes("Anonymous calls") ? "AnonymousScope" : "UnexpectedError", null);
          }
        }
        return { accountId: "owner", role: "owner" };
      },
    });
    export default provide(auth.method, {
      id: "passcode", name: "Passcode", form: { passcode: "password" }, signIn,
    });
  `;
  const alternateFile = join(alternate, "src/server/method.ts");
  await writeFile(alternateFile, alternateMethod);
  await writeFile(join(alternate, "src/server/api.ts"), 'export { alive } from "./method";');
  buildDirectory(alternate);
  await serve(binary, root, plugins, true, async (address) => {
    for (const [passcode, kind] of [
      ["own", "AnonymousScope"],
      ["peer", "AnonymousScope"],
      ["test", "AccountNotLinked"],
    ]) {
      const response = await request(address, "/auth/sign-in", {
        method: "passcode",
        fields: { passcode },
        deviceName: "Test client",
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).kind, kind);
    }
    if (selectedRuntime(binary).runtime === "quickjs") {
      const signIn = (passcode) =>
        request(address, "/auth/sign-in", {
          method: "passcode",
          fields: { passcode },
          deviceName: "Test client",
        });
      const started = performance.now();
      assert.equal((await within(signIn("hang"), "anonymous deadline", 16_000)).status, 503);
      assert.ok(performance.now() - started >= 800, "sign-in kept its call budget");

      await withClient(address, ownerToken, async (client) => {
        const signed = client.action(createApi("alternate-auth").method.alive, {});
        await Bun.sleep(150);
        const spins = signIn("spin");
        const [value, response] = await Promise.all([signed, spins]);
        assert.equal(response.status, 503);
        assert.equal(value, "alive");
      });
    }
  });
  await writeFile(alternateFile, alternateMethod.replace('"password"', '"number" as never'));
  buildDirectory(alternate);
  const malformedLogs = await serve(binary, root, plugins, true, async (address) => {
    await discovery(address, {
      methods: [provider],
      ownerSetup: false,
    });
    assert.equal((await signIn(address, "sam")).status, 200);
  });
  assert.match(malformedLogs, /Skipping plugin alternate-auth: .*requires a form/);
  for (const module of ["method", "accounts"]) {
    const file = join(basicAuth, `src/server/${module}.ts`);
    const original = await readFile(file, "utf8");
    const sentinel = `Broken basic-auth ${module}`;
    await writeFile(file, original + `\nthrow new Error("${sentinel}");`);
    buildDirectory(basicAuth);
    const brokenLogs = await serve(binary, root, plugins, true, async (address) => {
      await discovery(address, { methods: [], ownerSetup: false });
      assert.equal((await signIn(address, "sam")).status, 503);
      await withClient(address, firstKey, async (client) => {
        assert.deepEqual((await client.query(authCaller, {})).device, firstDevice);
      });
      await withClient(address, ownerToken, async (client) => {
        assert.equal((await client.query(authCaller, {})).user.role, "owner");
      });
    });
    assert.match(brokenLogs, new RegExp(`Skipping plugin basic-auth: .*${sentinel}`));
    await writeFile(file, original);
  }
}

async function copyAndBuildAuth(plugin, legacy) {
  const source = join(workspace, "plugins/basic-auth");
  await cp(source, plugin, {
    recursive: true,
    filter: (path) =>
      !path
        .slice(source.length)
        .split("/")
        .some((segment) => ["dist", ".tokamak", "node_modules"].includes(segment)),
  });
  await symlink(join(workspace, "app/node_modules"), join(plugin, "node_modules"), "dir");
  await writeFile(
    join(plugin, "src/server/tsconfig.json"),
    JSON.stringify({ extends: join(workspace, "tsconfig.json") }),
  );
  const file = join(plugin, "src/server/accounts.ts");
  const original = await readFile(file, "utf8");
  if (!legacy) {
    buildDirectory(plugin);
    return;
  }
  const historical = original.replace(
    "await ctx.crypto.hashPassword(input.password)",
    JSON.stringify(legacy),
  );
  assert.notEqual(historical, original, "seed an account with the historical hash");
  await writeFile(file, historical);
  buildDirectory(plugin);
  return async () => {
    await writeFile(file, original);
    buildDirectory(plugin);
  };
}

function buildDirectory(plugin) {
  const result = Bun.spawnSync([process.execPath, join(workspace, "packages/build/src/build.ts"), plugin], {
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(result.exitCode, 0, "sign-in plugin build");
}

async function verifyIdentity(plugin) {
  const installed = join(root, "identity-plugins");
  await mkdir(installed);
  await cp(join(plugin, "dist"), join(installed, "auth-test"), { recursive: true });
  await installBasicAuth(installed);
  await serve(binary, root, installed, true, async (address) => {
    assert.equal((await admin(address, "/members", { name: "Alice", role: "owner" })).status, 400);
    const { key: token } = await signInMember(address, ownerToken, "Alice");
    for (const path of ["/account", "/plugins", "/ws"]) {
      const url = new URL(path, address.replace(/^ws:/, "http:"));
      url.searchParams.set("token", token);
      assert.equal((await fetch(url)).status, 401, `${path} refuses the URL credential`);
    }
    await assertRefused(`${address}?token=${encodeURIComponent(token)}`, undefined);
    await withClient(address, token, async (client) => {
      const probe = await client.query(api.identity.read, {});
      const { auth } = probe;
      assert.equal(auth.user.name, "Alice");
      assert.equal(auth.user.role, "member");
      assert.ok(auth.user.id);
      assert.ok(auth.device.id);
      assert.ok(auth.device.name);
      assert.deepEqual(await client.mutation(api.identity.write, {}), probe);
      assert.deepEqual(await client.action(api.identity.run, {}), { ...probe, read: probe, write: probe });

      const invalidArgs = { user: "owner" };
      await assert.rejects(client.query(authCaller, invalidArgs), /requires empty arguments/);
      const rejected = await new Promise((resolve) => client.subscribe(authCaller, invalidArgs, resolve));
      assert.equal(rejected.terminal, true);
      assert.match(rejected.error.message, /requires empty arguments/);

      const updates = new ReadableStream({
        start(controller) {
          this.stop = client.subscribe(authCaller, {}, (event) => {
            if ("error" in event) controller.error(event.error);
            else controller.enqueue(event.value);
          });
        },
        cancel() {
          this.stop();
        },
      }).getReader();
      try {
        assert.deepEqual((await updates.read()).value, auth);
        assert.equal((await admin(address, "/account", { name: "Alicia" }, token)).status, 200);
        const renamed = (await updates.read()).value;
        assert.deepEqual(renamed, { ...auth, user: { ...auth.user, name: "Alicia" } });
        const role = `/members/${auth.user.id}/role`;
        assert.equal((await admin(address, role, { role: "admin" }, token)).status, 403);
        assert.equal((await admin(address, role, { role: "owner" })).status, 400);
        assert.equal((await admin(address, "/members/owner/role", { role: "member" })).status, 400);
        assert.equal((await admin(address, "/members/owner/revoke")).status, 400);
        assert.equal((await admin(address, role, { role: "admin" })).status, 200);
        const promoted = (await updates.read()).value;
        assert.deepEqual(promoted, { ...renamed, user: { ...renamed.user, role: "admin" } });
        assert.deepEqual((await client.query(api.identity.read, {})).auth, promoted);
        assert.equal((await admin(address, "/plugins/auth/reload")).status, 400);
      } finally {
        await updates.cancel();
      }
      await withClient(address, ownerToken, async (owner) => {
        const identity = await owner.query(authCaller, {});
        assert.equal(identity.user.role, "owner");
        assert.notEqual(identity.device.id, auth.device.id);
      });
    });
  });
  const brokenRoot = join(root, "broken");
  const brokenSource = await buildPlugin(brokenRoot, true);
  const broken = join(brokenRoot, "plugins");
  await mkdir(broken);
  await cp(join(brokenSource, "dist"), join(broken, "auth-test"), { recursive: true });
  await installBasicAuth(broken);
  const legacyKey = "existing-invite-credential-before-device-keys";
  const laptop = { id: "known-laptop", name: "Laptop" };
  const ownerDevice = { id: "known-owner-laptop", name: "Owner laptop" };
  const laptopKey = "previously-issued-laptop-key";
  const spareKey = "previously-issued-spare-key";
  const ownerDeviceKey = "previously-issued-owner-device-key";
  const issued = (device, key) => ({ ...device, kind: "device", token_hash: sha256(key) });
  const spare = { id: "known-spare", name: "Spare" };
  await mkdir(join(brokenRoot, "shared"));
  await writeFile(
    join(brokenRoot, "shared", "members.json"),
    JSON.stringify([
      {
        id: "owner",
        name: "Test Owner",
        role: "owner",
        token_hash: sha256(ownerToken),
        created_at: 1,
        devices: [issued(ownerDevice, ownerDeviceKey)],
      },
      {
        id: "alice",
        name: "Alice",
        role: "member",
        token_hash: sha256(legacyKey),
        created_at: 1,
        devices: [issued(laptop, laptopKey), issued(spare, spareKey)],
      },
    ]),
  );
  const audit = await serve(binary, brokenRoot, broken, true, async (address, dir) => {
    await withClient(address, legacyKey, async (first, firstSocket) => {
      const { user, device } = await first.query(authCaller, {});
      assert.deepEqual(device, { id: "device:alice", name: "Invite device" });
      const catalog = await appRequest(address, "/plugins", legacyKey);
      assert.equal(catalog.status, 200);
      const metadata = await catalog.json();
      assert.deepEqual(
        metadata.plugins.map((plugin) => plugin.plugin.id),
        ["basic-auth"],
      );
      assert.match(metadata.skipped?.["auth-test"] ?? "", /Broken plugin/);
      const key = laptopKey;
      const saved = await Bun.file(join(dir, "members.json")).text();
      assert.ok(!saved.includes(key), "device key stored in plain text");
      assert.ok(saved.includes(sha256(key)), "SHA-256 digest is missing");
      assert.ok(!saved.includes(legacyKey), "invite key stored in plain text");
      assert.ok(JSON.parse(saved).every((member) => !("token_hash" in member)));
      await verifyBearerRequest(address, "/devices/live", "GET", legacyKey);
      await deviceUpdates(address, legacyKey, async (next) => {
        const devices = await next();
        assert.equal(devices.length, 3);
        assert.equal(devices.find((entry) => entry.id === device.id).current, true);
        assert.equal(devices.find((entry) => entry.name === "Laptop").lastSeen, null);
        assert.equal(devices.find((entry) => entry.name === "Laptop").online, false);
        await withClient(address, key, async (second, socket) => {
          const caller = await second.query(authCaller, {});
          assert.deepEqual(caller.user, user);
          assert.notEqual(caller.device.id, device.id);
          assert.equal(caller.device.name, "Laptop");
          const seen = (await next()).find((entry) => entry.id === caller.device.id);
          assert.equal(seen.name, "Laptop");
          assert.ok(seen.lastSeen > 0);
          assert.equal(seen.online, true);
          assert.equal(await Bun.file(join(dir, "members.json")).text(), saved);
          let closingAfter;
          await withClient(address, key, async (parallel) => {
            assert.deepEqual(await parallel.query(authCaller, {}), caller);
            // Let the wall clock advance so the close is distinguishable from the open.
            await Bun.sleep(5);
            closingAfter = Date.now();
          });
          // A second socket closing is a last-seen update, but the first is still open.
          let latest = seen;
          while (latest.lastSeen < closingAfter) {
            latest = (await next()).find((entry) => entry.id === caller.device.id);
          }
          assert.equal(latest.online, true);
          assert.equal(await Bun.file(join(dir, "members.json")).text(), saved);
          const target = `/devices/${caller.device.id}/revoke`;
          await verifyBearerRequest(address, target, "POST", legacyKey);
          const signedOut = closed(socket);
          const signOut = await appRequest(address, target, legacyKey, "POST");
          assert.equal(signOut.status, 200);
          assert.equal((await within(signedOut, "signed-out connection closes", 2_000)).code, 4001);
          assert.deepEqual(new Set((await next()).map((entry) => entry.id)), new Set([device.id, spare.id]));
          await assertRefused(address, key);
          assert.deepEqual(await first.query(authCaller, {}), { user, device });
        });
      });
      await verifyDevicePermissions(address, device, firstSocket, ownerDevice, ownerDeviceKey);
      await deviceUpdates(address, ownerToken, async (next) => {
        await next();
        await withClient(address, spareKey, async (spare) => {
          assert.equal((await spare.query(authCaller, {})).device.name, "Spare");
          assert.equal((await next()).find((entry) => entry.name === "Spare").online, true);
        });
        assert.equal((await next()).find((entry) => entry.name === "Spare").online, false);
        const saved = await Bun.file(join(dir, "members.json")).json();
        assert.equal(
          saved.flatMap((member) => member.devices).find((entry) => entry.name === "Spare").last_seen,
          undefined,
        );
      });
    });
  });
  assert.match(audit, /Skipping plugin auth-test: .*Broken plugin/);
  const afterShutdown = await Bun.file(join(brokenRoot, "shared", "members.json")).json();
  assert.ok(
    afterShutdown.flatMap((member) => member.devices).find((entry) => entry.name === "Spare").last_seen > 0,
  );
  await serve(binary, brokenRoot, broken, true, async (address) => {
    await assertRefused(address, laptopKey);
    await assertRefused(address, legacyKey);
    await withClient(address, spareKey, async (client) => {
      assert.equal((await client.query(authCaller, {})).device.name, "Spare");
    });
    await withClient(address, ownerToken, async (client) => {
      const { user, device } = await client.query(authCaller, {});
      assert.equal(user.role, "owner");
      assert.equal(device.name, "Owner key");
    });
  });
  // The core read works even if there are no installed plugins.
  const emptyPlugins = join(root, "empty");
  await mkdir(emptyPlugins);
  await serve(binary, root, emptyPlugins, false, async (address) => {
    await withClient(address, undefined, async (client) => {
      const { user, device } = await client.query(authCaller, {});
      assert.deepEqual(user, { id: "local", name: "Test Owner", role: "owner" });
      const computerName =
        process.platform === "darwin"
          ? Bun.spawnSync(["/usr/sbin/scutil", "--get", "ComputerName"]).stdout.toString().trim()
          : process.platform === "win32"
            ? process.env.COMPUTERNAME
            : hostname();
      assert.equal(device.name, computerName || hostname());
    });
  });
}
