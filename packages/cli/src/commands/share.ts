import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokamakVersion } from "../../../tokamak-version";
import { json, loopback, request, type Endpoint } from "../../../runtime/tools/server-discovery";
import { CommandError, type Command } from "../command";
import { packageIdentity } from "../plugin-package";
import { sharingEndpoint, sharingRequest } from "../server";
import { packPlugin } from "./pack";

declare const Bun: { semver: { order(left: string, right: string): number } };

const example = "tokamak plugin share ./my-plugin --server https://tokamak.example.com";
const help = "tokamak plugin share --help";

async function checkVersion({ url }: Endpoint) {
  const response = await request("/version", { url });
  if (!response.ok) throw new Error(`Server version request returned HTTP ${response.status}`);
  const info = (await json(response)) as { version?: unknown } | null;
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

async function downloadPackage(source: string) {
  let url = new URL(source);
  const signal = AbortSignal.timeout(30_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname)))
      throw new CommandError("Package links must use HTTPS (HTTP is allowed on loopback)", help);
    if (url.username || url.password)
      throw new CommandError("Package links cannot contain credentials", help);
    const response = await fetch(url, { redirect: "manual", signal });
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
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
  if (!(await stat(source)).isDirectory()) return readFile(source);

  const temporary = await mkdtemp(join(tmpdir(), "tokamak-share-"));
  try {
    const { path } = await packPlugin(source, temporary, help);
    return await readFile(path);
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
    const { id, runtime, buildId } = packageIdentity(bytes);
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
