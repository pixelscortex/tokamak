import { createHash } from "node:crypto";
import type { Plugin } from "vite";

type GenerateBundle = Extract<NonNullable<Plugin["generateBundle"]>, (...args: never[]) => unknown>;

export function artifactBundle(): GenerateBundle {
  return function (_options, bundle) {
    delete bundle[".tokamak-backend-entry.js"];
    // Commit the hashes of final emitted bytes, not intermediate compiler
    // inputs. A loader snapshots and verifies these before evaluating code.
    const manifest = artifactManifest(bundle);
    const hashes = bundleHashes(bundle);
    const metadata = JSON.parse(String(manifest.source));
    manifest.source = JSON.stringify({ ...metadata, hashes }, null, 2) + "\n";
  };
}

function bundleHashes(bundle: Parameters<GenerateBundle>[1]) {
  const hashes: Record<string, string> = {};
  for (const [name, file] of Object.entries(bundle)) {
    if (name === "manifest.json") continue;
    hashes[name] = createHash("sha256")
      .update(file.type === "chunk" ? file.code : file.source)
      .digest("hex");
  }
  return hashes;
}

function artifactManifest(bundle: Parameters<GenerateBundle>[1]) {
  const manifest = bundle["manifest.json"];
  if (!manifest || manifest.type !== "asset") throw new Error("Missing artifact manifest");
  return manifest;
}
