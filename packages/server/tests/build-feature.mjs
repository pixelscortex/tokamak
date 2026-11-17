// Build real SDK fixtures in fresh, exclusively owned directories. Standalone
// builds retain artifacts; --load transfers their contents and always cleans up.
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleFeature } from "../../sdk/tools/bundle.mjs";

export async function buildFeature({
  source = fileURLToPath(new URL("./fixtures/feature/", import.meta.url)),
  parent = fileURLToPath(new URL("../target/", import.meta.url)),
} = {}) {
  await mkdir(parent, { recursive: true });
  const feature = await mkdtemp(join(parent, "tkm5-feature-"));
  try {
    await cp(source, feature, { recursive: true });
    // Resolve the installed workspace SDK as a package, just like plugin authors.
    await symlink(
      fileURLToPath(new URL("../../../app/node_modules", import.meta.url)),
      join(feature, "node_modules"),
      "dir",
    );
    await Bun.write(
      join(feature, "tsconfig.json"),
      JSON.stringify({
        extends: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
      }),
    );
    await bundleFeature(feature);
    return feature;
  } catch (error) {
    await rm(feature, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  if (process.argv.slice(2).some((arg) => arg !== "--load"))
    throw new Error("Expected no arguments or --load");
  const feature = await buildFeature();
  if (process.argv.includes("--load")) {
    try {
      // The final stdout line is a JSON payload; preceding SDK diagnostics stay
      // visible to callers on failure. Rust never owns or deletes another build.
      console.log(
        JSON.stringify({
          code: await readFile(join(feature, "dist/bundle.js"), "utf8"),
          map: await readFile(join(feature, "dist/bundle.js.map"), "utf8"),
        }),
      );
    } finally {
      await rm(feature, { recursive: true, force: true });
    }
  } else {
    console.log(feature);
  }
}
