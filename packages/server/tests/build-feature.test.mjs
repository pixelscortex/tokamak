// Regressions for stale fixture modules and competing test-process artifacts;
// inspect real SDK descriptors, not directory-name uniqueness alone.
import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const builder = new URL("./build-feature.mjs", import.meta.url).href;
const target = fileURLToPath(new URL("../target/", import.meta.url));

async function temporary(check) {
  await mkdir(target, { recursive: true });
  const root = await mkdtemp(join(target, "tkm5-build-regression-"));
  try {
    await check(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function sourceAt(root, name) {
  const source = join(root, name);
  await mkdir(source);
  return source;
}

async function query(source, module, value) {
  await writeFile(
    join(source, `${module}.ts`),
    `import { query } from '@tokamak/sdk';
export const read = query({ handler: () => ${JSON.stringify(value)} });\n`,
  );
}

// Each invocation is an independent OS process, as with concurrent Cargo runs.
async function build(source, parent) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { buildFeature } from ${JSON.stringify(builder)};
console.log(JSON.stringify(await buildFeature(${JSON.stringify({ source, parent })})));`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function output(result) {
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

async function describe(feature) {
  // Read artifacts anew so module caching cannot hide another process deleting
  // or overwriting them. The real registry must match the current source set.
  const code = await readFile(join(feature, "dist/bundle.js"), "utf8");
  expect(JSON.parse(await readFile(join(feature, "dist/bundle.js.map"), "utf8")).version).toBe(3);
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return module
    .describe()
    .functions.map((fn) => fn.name)
    .sort();
}

// Real failure: copying over an old destination left deleted .ts modules in
// the next SDK scan, so describe() continued advertising obsolete handlers.
test("a deleted source module disappears from the next build descriptor", async () => {
  await temporary(async (root) => {
    const source = await sourceAt(root, "source");
    const parent = join(root, "builds");
    await query(source, "current", "current");
    await query(source, "obsolete", "obsolete");
    const before = output(await build(source, parent));
    expect(await describe(before)).toEqual(["current:read", "obsolete:read"]);
    await rm(join(source, "obsolete.ts"));
    const after = output(await build(source, parent));
    expect(await describe(after)).toEqual(["current:read"]);
    expect(await readdir(after)).not.toContain("obsolete.ts");
    expect(await describe(before)).toEqual(["current:read", "obsolete:read"]);
  });
}, 30_000);

// Competing processes must build different feature contents without overwriting
// each other; deleting one owner's output must not invalidate the other owner.
test("concurrent build processes retain isolated, independently removable bundles", async () => {
  await temporary(async (root) => {
    const left = await sourceAt(root, "left");
    const right = await sourceAt(root, "right");
    await query(left, "left", "left value");
    await query(right, "right", "right value");
    const parent = join(root, "builds");
    const [a, b] = (await Promise.all([build(left, parent), build(right, parent)])).map(output);
    expect(await describe(a)).toEqual(["left:read"]);
    expect(await describe(b)).toEqual(["right:read"]);
    const survivor = await readFile(join(b, "dist/bundle.js"), "utf8");
    await rm(a, { recursive: true });
    expect(await readFile(join(b, "dist/bundle.js"), "utf8")).toBe(survivor);
    expect(await describe(b)).toEqual(["right:read"]);
  });
}, 30_000);

// A real checker failure must clean only the failed build, not a successful
// sibling's artifacts. Missing-source copy failure exercises the earlier path.
test("failed builds remove their temporary output and preserve successful siblings", async () => {
  await temporary(async (root) => {
    const source = await sourceAt(root, "source");
    const parent = join(root, "builds");
    await query(source, "valid", "retained");
    const retained = output(await build(source, parent));
    const entries = await readdir(parent);
    await writeFile(join(source, "invalid.ts"), "export const invalid: string = 42;\n");
    const invalid = await build(source, parent);
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toContain("Feature type check failed");
    expect(await readdir(parent)).toEqual(entries);
    expect((await build(join(root, "missing"), parent)).code).not.toBe(0);
    expect(await readdir(parent)).toEqual(entries);
    expect(await describe(retained)).toEqual(["valid:read"]);
  });
}, 30_000);
