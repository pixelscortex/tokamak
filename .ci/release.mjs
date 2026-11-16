// Shared by Depot CI and Actions. Only a complete, verified main commit replaces
// the published nightly; per-commit drafts prevent mixed-platform releases.
import { createHash } from "node:crypto";
import { basename } from "node:path";

export const archives = [
  "server-linux-x64.tar.gz",
  "server-linux-arm64.tar.gz",
  "server-macos-arm64.tar.gz",
  "desktop-macos-arm64.tar.gz",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const candidateTag = (sha) => `ci-main-${sha}`;

export class GitHub {
  constructor(repository, token, request = fetch) {
    this.repository = repository;
    this.token = token;
    this.request = request;
  }
  async api(path, method = "GET", data, raw = false) {
    const url = path.startsWith("https://") ? path : `https://api.github.com/repos/${this.repository}${path}`;
    const response = await this.request(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: raw ? "application/octet-stream" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": data instanceof Uint8Array ? "application/octet-stream" : "application/json",
      },
      body: data === undefined ? undefined : data instanceof Uint8Array ? data : JSON.stringify(data),
    });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok)
      throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
    if (response.status === 204) return null;
    return raw ? new Uint8Array(await response.arrayBuffer()) : response.json();
  }
  async releases() {
    const all = [];
    for (let page = 1; ; page++) {
      const batch = await this.api(`/releases?per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }
  async current(sha) {
    const ref = await this.api("/git/ref/heads/main");
    return ref.object.sha === sha;
  }
  async candidate(sha, create = false) {
    const releases = await this.releases();
    const existing = releases.find((release) => release.tag_name === candidateTag(sha));
    if (existing) {
      if (!existing.draft) throw new Error("Release candidate must remain a draft");
      return existing;
    }
    if (!create) return null;
    try {
      return await this.api("/releases", "POST", {
        tag_name: candidateTag(sha),
        target_commitish: sha,
        draft: true,
        prerelease: true,
        name: `Preparing main ${sha.slice(0, 7)}`,
      });
    } catch (error) {
      // Linux architectures and macOS can race to create the same draft.
      const raced = await this.candidate(sha);
      if (raced) return raced;
      throw error;
    }
  }
  async upload(release, name, bytes) {
    const assets = await this.api(`/releases/${release.id}/assets?per_page=100`);
    const existing = assets.find((asset) => asset.name === name);
    if (existing) await this.api(`/releases/assets/${existing.id}`, "DELETE");
    return this.api(`${release.upload_url.split("{")[0]}?name=${encodeURIComponent(name)}`, "POST", bytes);
  }
}

export async function stage(
  github,
  sha,
  paths,
  read = async (path) => new Uint8Array(await Bun.file(path).arrayBuffer()),
) {
  if (!(await github.current(sha))) return "stale";
  if (!paths.length || paths.some((path) => !archives.includes(basename(path))))
    throw new Error("Unexpected release archive");
  const release = await github.candidate(sha, true);
  for (const path of paths) {
    const name = basename(path);
    const bytes = await read(path);
    const checksum = `${digest(bytes)}  ${name}\n`;
    await github.upload(release, name, bytes);
    await github.upload(release, `${name}.sha256`, new TextEncoder().encode(checksum));
    if (import.meta.main) await Bun.write(`${path}.sha256`, checksum);
  }
  // repository_dispatch is one of the events GITHUB_TOKEN may trigger in Actions.
  await github.api("/dispatches", "POST", { event_type: "nightly-ready", client_payload: { sha } });
  return "staged";
}

export async function publish(github, sha) {
  if (!(await github.current(sha))) return "stale";
  const release = await github.candidate(sha);
  if (!release) return "no candidate";
  const assets = await github.api(`/releases/${release.id}/assets?per_page=100`);
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  const required = archives.flatMap((name) => [name, `${name}.sha256`]);
  const missing = required.filter((name) => !byName.has(name));
  if (missing.length) return `waiting for ${missing.join(", ")}`;
  const sums = [];
  for (const name of archives) {
    const bytes = await github.api(byName.get(name).url, "GET", undefined, true);
    const checksum = new TextDecoder().decode(
      await github.api(byName.get(`${name}.sha256`).url, "GET", undefined, true),
    );
    const expected = `${digest(bytes)}  ${name}\n`;
    if (checksum !== expected) throw new Error(`Checksum mismatch: ${name}`);
    sums.push(expected);
  }
  await github.upload(release, "SHA256SUMS.txt", new TextEncoder().encode(sums.join("")));
  // Recheck after downloads, immediately before replacing the rolling release.
  if (!(await github.current(sha))) return "stale";
  const nightly = (await github.releases()).find((item) => item.tag_name === "nightly");
  if (nightly) await github.api(`/releases/${nightly.id}`, "DELETE");
  const ref = await github.api("/git/ref/tags/nightly");
  if (ref) await github.api("/git/refs/tags/nightly", "PATCH", { sha, force: true });
  else await github.api("/git/refs", "POST", { ref: "refs/tags/nightly", sha });
  await github.api(`/releases/${release.id}`, "PATCH", {
    tag_name: "nightly",
    target_commitish: sha,
    draft: false,
    prerelease: true,
    make_latest: "false",
    name: `main ${sha.slice(0, 7)}`,
    body: `Built from https://github.com/${github.repository}/commit/${sha}\n\nUnsigned development binaries. SHA-256 checksums are included. Signing and macOS notarization will be added before packaging.`,
  });
  // Clean only this pipeline's temporary tags/drafts, never other releases.
  const temporaryTags = new Set([candidateTag(sha)]);
  for (const old of await github.releases()) {
    if (old.draft && /^ci-main-[a-f0-9]{40}$/.test(old.tag_name)) {
      await github.api(`/releases/${old.id}`, "DELETE");
      temporaryTags.add(old.tag_name);
    }
  }
  for (const tag of temporaryTags) {
    if (await github.api(`/git/ref/tags/${tag}`)) await github.api(`/git/refs/tags/${tag}`, "DELETE");
  }
  return "published";
}

if (import.meta.main) {
  const { GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_REF, GITHUB_EVENT_NAME, GITHUB_SHA, RELEASE_SHA } =
    process.env;
  if (GITHUB_REF !== "refs/heads/main" || GITHUB_EVENT_NAME === "pull_request")
    throw new Error("Releases require main");
  const sha = RELEASE_SHA || GITHUB_SHA;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !/^[a-f0-9]{40}$/.test(sha ?? ""))
    throw new Error("Missing release context");
  const github = new GitHub(GITHUB_REPOSITORY, GITHUB_TOKEN);
  const [mode, ...paths] = process.argv.slice(2);
  if (mode === "stage") console.log(await stage(github, sha, paths));
  else if (mode === "publish") console.log(await publish(github, sha));
  else throw new Error("Expected stage or publish");
}
