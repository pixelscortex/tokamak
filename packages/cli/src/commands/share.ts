import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokamakVersion } from "../../../tokamak-version";
import { loopback, type Endpoint } from "../../../runtime/tools/server-discovery";
import { CommandError, type Command } from "../command";
import { PACKAGE_BYTES, packageIdentity } from "../plugin-package";
import { sharingEndpoint, sharingRequest } from "../server";
import { packPlugin } from "./pack";

declare const Bun: { semver: { order(left: string, right: string): number } };

const example = "tokamak plugin share ./my-plugin --server https://tokamak.example.com";
const help = "tokamak plugin share --help";

async function checkVersion(endpoint: Endpoint) {
  const info = (await sharingRequest("/version", endpoint)) as { version?: unknown } | null;
  const server = info?.version;
  const cli = tokamakVersion();
  const releaseLine = (version: string) => version.split(".").slice(0, 2).join(".");
  if (
    typeof server !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(server)
  )
    throw new Error("Server did not report a valid version");
  const order = Bun.semver.order(cli, server);
  if (releaseLine(cli) !== releaseLine(server) || order > 0) {
    const next = order > 0 ? "Upgrade the server" : "Upgrade the CLI";
    throw new CommandError(`${next}: CLI ${cli} and server ${server} are incompatible`, next);
  }
}

function packageTooLarge() {
  return new CommandError("Package is larger than 50 MiB", help);
}

async function readDownload(response: Response) {
  if (!response.body) return new Uint8Array();
  if (Number(response.headers.get("content-length")) > PACKAGE_BYTES) {
    await response.body.cancel();
    throw packageTooLarge();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > PACKAGE_BYTES) throw packageTooLarge();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readZipFile(source: string) {
  const file = await open(source, "r");
  try {
    const metadata = await file.stat();
    if (metadata.size > PACKAGE_BYTES) throw packageTooLarge();
    // Bound the read even if the file grows after the size check.
    const chunks: Buffer[] = [];
    let total = 0;
    if (metadata.isFile()) {
      for await (const chunk of file.createReadStream({ end: PACKAGE_BYTES, autoClose: false })) {
        chunks.push(chunk as Buffer);
        total += chunk.length;
        if (total > PACKAGE_BYTES) throw packageTooLarge();
      }
    }
    return Buffer.concat(chunks, total);
  } finally {
    await file.close();
  }
}

async function downloadPackage(source: string) {
  let url = new URL(source);
  const signal = AbortSignal.timeout(30_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname)))
      throw new CommandError("Package links must use HTTPS (HTTP is allowed on loopback)", help);
    if (url.username || url.password)
      throw new CommandError("Package links cannot contain credentials", help);
    const response = await fetch(url, { redirect: "manual", signal });
    if (response.ok) return readDownload(response);
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status) || !location)
      throw new Error(`Package download returned HTTP ${response.status}`);
    url = new URL(location, url);
  }
  throw new Error("Package download redirected too many times");
}

async function readPackage(source: string) {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(source)) return downloadPackage(source);
  if (!(await stat(source)).isDirectory()) return readZipFile(source);

  const temporary = await mkdtemp(join(tmpdir(), "tokamak-share-"));
  try {
    const { path } = await packPlugin(source, temporary, help);
    return await readZipFile(path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export default {
  path: "plugin share",
  usesServer: true,
  summary: "Install or update a plugin on a selected server.",
  args: { name: "folder, zip or link" },
  example,
  async run([source], { server }) {
    const endpoint = sharingEndpoint(server, example);
    await checkVersion(endpoint);
    const bytes = await readPackage(source!);
    const { id, runtime, buildId } = (() => {
      try {
        return packageIdentity(bytes);
      } catch {
        throw new CommandError(`Not a Tokamak plugin package: ${source}`, help);
      }
    })();
    if (runtime === "worker")
      throw new CommandError("Plugins with machine actions cannot be shared yet", help);
    const data = (await sharingRequest(`/plugins/${encodeURIComponent(id)}/package`, endpoint, {
      method: "PUT",
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(bytes.byteLength),
        "x-tokamak-build-id": buildId,
      },
      body: bytes,
    })) as { id: string; version: string; buildId: string; status: string };
    return { data, text: `${data.status}: ${data.id} ${data.version} (build id ${data.buildId})` };
  },
} satisfies Command;
