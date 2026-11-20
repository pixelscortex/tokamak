import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

export function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function packageIdentity(bytes: Uint8Array) {
  // Read only the manifest. The server validates the complete package.
  const manifest = unzipSync(bytes, {
    filter: ({ name, originalSize }) => name === "manifest.json" && originalSize <= 50 * 1024 * 1024,
  })["manifest.json"];
  if (!manifest) throw new Error("ZIP package is missing a readable manifest.json");
  const { plugin } = JSON.parse(new TextDecoder().decode(manifest)) as {
    plugin?: { id?: unknown; runtime?: unknown };
  };
  if (typeof plugin?.id !== "string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(plugin.id))
    throw new Error("Invalid plugin identity in the package manifest");
  return { id: plugin.id, runtime: plugin.runtime, buildId: sha256(manifest) };
}
