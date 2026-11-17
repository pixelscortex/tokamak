import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { archives, GitHub, publish, stage } from "./release.mjs";

const sha = "a".repeat(40);
const bytes = (text: string) => new TextEncoder().encode(text);
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
function fixture({ missing = false, corrupt = false, stale = false, advance = false } = {}) {
  const writes: { path: string; data?: any }[] = [];
  const files = new Map<string, Uint8Array>();
  for (const name of archives) {
    files.set(name, bytes(name));
    files.set(`${name}.sha256`, bytes(`${corrupt ? "0".repeat(64) : hash(bytes(name))}  ${name}\n`));
  }
  if (missing) files.delete(archives[0]);
  const release = {
    id: 2,
    draft: true,
    tag_name: `ci-main-${sha}`,
    upload_url: "https://uploads.test/assets{?name}",
  };
  let reads = 0;
  const github = {
    repository: "owner/repo",
    current: async () => !stale && !(advance && ++reads > 1),
    candidate: async () => release,
    releases: async () => [{ id: 1, tag_name: "nightly", draft: false }],
    upload: async (_release: unknown, name: string, data: Uint8Array) => {
      writes.push({ path: name, data });
    },
    api: async (path: string, method = "GET", data?: unknown) => {
      if (method !== "GET") {
        writes.push({ path: `${method} ${path}`, data });
        return {};
      }
      if (path === "/releases/2/assets?per_page=100")
        return [...files.keys()].map((name) => ({ name, url: `asset:${name}` }));
      if (path === "/git/ref/tags/nightly") return { object: { sha: "b".repeat(40) } };
      if (path.startsWith("/git/ref/tags/ci-main-")) return null;
      if (path.startsWith("asset:")) return files.get(path.slice(6));
      throw new Error(`Unexpected request ${path}`);
    },
  };
  return { github, writes };
}

describe("main release coordination", () => {
  test("stages platform assets and checksums before notifying the publisher", async () => {
    const { github, writes } = fixture();
    expect(await stage(github, sha, [archives[0]], async () => bytes("binary"))).toBe("staged");
    expect(writes.map((w) => w.path)).toEqual([archives[0], `${archives[0]}.sha256`, "POST /dispatches"]);
    expect(new TextDecoder().decode(writes[1].data)).toBe(`${hash(bytes("binary"))}  ${archives[0]}\n`);
  });
  test("rejects unexpected asset names", async () => {
    const { github, writes } = fixture();
    await expect(stage(github, sha, ["unexpected.tar.gz"])).rejects.toThrow("Unexpected release archive");
    expect(writes).toHaveLength(0);
  });
  test("stale commits never stage or publish", async () => {
    const { github, writes } = fixture({ stale: true });
    expect(await stage(github, sha, [archives[0]])).toBe("stale");
    expect(await publish(github, sha)).toBe("stale");
    expect(writes).toHaveLength(0);
  });
  test("an incomplete platform set keeps the previous nightly untouched", async () => {
    const { github, writes } = fixture({ missing: true });
    expect(await publish(github, sha)).toContain("waiting for");
    expect(writes).toHaveLength(0);
  });
  test("a checksum mismatch prevents replacement", async () => {
    const { github, writes } = fixture({ corrupt: true });
    await expect(publish(github, sha)).rejects.toThrow("Checksum mismatch");
    expect(writes).toHaveLength(0);
  });
  test("a complete candidate produces a prerelease, checksums and the rolling tag", async () => {
    const { github, writes } = fixture();
    expect(await publish(github, sha)).toBe("published");
    expect(writes.map((w) => w.path)).toEqual([
      "SHA256SUMS.txt",
      "DELETE /releases/1",
      "PATCH /git/refs/tags/nightly",
      "PATCH /releases/2",
    ]);
    expect(new TextDecoder().decode(writes[0].data).split("\n").filter(Boolean)).toHaveLength(3);
    expect(writes[3].data).toMatchObject({
      tag_name: "nightly",
      target_commitish: sha,
      draft: false,
      prerelease: true,
      make_latest: "false",
    });
  });
  test("main advancing during verification leaves the previous release intact", async () => {
    const { github, writes } = fixture({ advance: true });
    expect(await publish(github, sha)).toBe("stale");
    expect(writes.map((w) => w.path)).toEqual(["SHA256SUMS.txt"]);
  });
  test("parallel candidate creation reuses the winning draft", async () => {
    let lists = 0;
    const draft = { id: 2, tag_name: `ci-main-${sha}`, draft: true };
    const github = new GitHub("owner/repo", "test", async (_url: string, options: RequestInit) => {
      if (options.method === "POST") return Response.json({ message: "already exists" }, { status: 422 });
      return Response.json(++lists === 1 ? [] : [draft]);
    });
    expect(await github.candidate(sha, true)).toEqual(draft);
  });
  test("the CLI rejects branch and PR publication before contacting GitHub", () => {
    const child = Bun.spawnSync([process.execPath, ".ci/release.mjs", "publish"], {
      env: { ...process.env, GITHUB_REF: "refs/heads/ci/depot", GITHUB_EVENT_NAME: "pull_request" },
    });
    expect(child.exitCode).toBe(1);
    expect(new TextDecoder().decode(child.stderr)).toContain("Releases require main");
  });
});
