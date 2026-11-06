// Shared build-only TSX compilation for native bundles. Babel must parse types
// before Solid rewrites JSX; Bun subsequently erases the preserved TypeScript.
import { transformAsync } from "@babel/core";
import solid from "babel-preset-solid";

// Inline maps preserve original TSX through a subsequent bundling stage when
// requested; production leaves them disabled so runtime bundle bytes do not grow.
export async function transformNativeTsx(source, filename, { sourceMaps = false } = {}) {
  const output = await transformAsync(source, {
    filename,
    configFile: false,
    babelrc: false,
    sourceMaps,
    parserOpts: { plugins: ["typescript", "jsx"] },
    presets: [[solid, { generate: "universal", moduleName: "@tokamak/render" }]],
  });

  if (output?.code == null) throw new Error(`Native TSX transform produced no code: ${filename}`);

  return output.code;
}
