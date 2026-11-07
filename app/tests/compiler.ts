/** Owner-approved build cleanup acceptance. Run the shipped zero-option Vite
 * config in a disposable spaced checkout; never edit production build sources.
 * NativeDocument tests separately execute the actual generated app artifacts. */
import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertOriginalMapping } from "../../packages/render/tests/source-maps";

const app = fileURLToPath(new URL("../", import.meta.url));
const repository = fileURLToPath(new URL("../../", import.meta.url));
const output = join(app, "dist/tests");
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(output, "compiler-"));
const workspace = join(scratch, "checkout with spaces");
const fixture = join(workspace, "app");
const frontend = join(fixture, "src/main.tsx");
const backend = join(fixture, "backend/todo.ts");

function command(args: string[], cwd = fixture) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: { ...process.env, NODE_ENV: "production" },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  return { status: result.status, text: `${result.stdout}\n${result.stderr}` };
}
function build(fromRoot = false) {
  return command(
    ["x", "--no-install", "vite", "build", ...(fromRoot ? ["--config", "app/vite.config.ts"] : [])],
    fromRoot ? workspace : fixture,
  );
}
function succeeds(result: ReturnType<typeof command>, context: string) {
  assert.equal(result.status, 0, `${context}\n${result.text}`);
}
function rejects(result: ReturnType<typeof command>, diagnostic: RegExp, context: string) {
  assert.notEqual(result.status, 0, `${context}: swallowed a real build/check failure`);
  assert.match(result.text, diagnostic, `${context}\n${result.text}`);
}
async function changed(path: string, source: string, check: () => void | Promise<void>) {
  const original = await readFile(path, "utf8");
  try {
    await writeFile(path, source);
    await check();
  } finally {
    await writeFile(path, original);
  }
}
async function missing(path: string, check: () => void) {
  const moved = `${path}.unavailable`;
  await rename(path, moved);
  try { check(); } finally { await rename(moved, path); }
}

try {
  await mkdir(fixture, { recursive: true });
  await cp(join(app, "src"), join(fixture, "src"), { recursive: true });
  await mkdir(join(fixture, "backend"));
  for (const name of ["schema.ts", "todo.ts", "_limits.ts", "tsconfig.json"]) {
    await copyFile(join(app, "backend", name), join(fixture, "backend", name));
  }
  for (const name of ["package.json", "vite.config.ts", "tsconfig.json", "tsconfig.tools.json"]) {
    await copyFile(join(app, name), join(fixture, name));
  }
  for (const name of ["package.json", "tsconfig.json"]) {
    await copyFile(join(repository, name), join(workspace, name));
  }
  await symlink(join(repository, "packages"), join(workspace, "packages"), "dir");
  await symlink(join(repository, "node_modules"), join(workspace, "node_modules"), "dir");
  await symlink(join(app, "node_modules"), join(fixture, "node_modules"), "dir");

  // Acceptance: use the ACTUAL zero-options config from both CLI entry points.
  // A space in the checkout path catches incorrect cwd resolution/quoting.
  const config = await readFile(join(fixture, "vite.config.ts"), "utf8");
  assert.match(config, /plugins:\s*\[\s*tokamak\(\)\s*\]/);
  succeeds(build(true), "workspace-cwd zero-option Vite build");
  succeeds(build(), "app-cwd zero-option Vite build");

  // Acceptance: no maintained HTML is necessary. CSS and the single native
  // mount point come from the production integration, not a test-written shell.
  const shell = await readFile(join(fixture, "dist/shell.html"), "utf8");
  assert.equal((shell.match(/id=["']app["']/g) ?? []).length, 1);
  for (const tag of ["html", "head", "body", "style"]) {
    assert.equal((shell.match(new RegExp(`<${tag}(?:>|\\s)`, "g")) ?? []).length, 1);
  }
  assert.match(shell, /\.panels\s*\{/);
  assert.match(shell, /\.panel\s*\{/);
  assert.doesNotMatch(shell, /@apply|@import|@vite\/client/);
  const generated = await readFile(join(fixture, "backend/_generated/api.ts"), "utf8");
  assert.match(generated, /readonly "todo"/);
  assert.doesNotMatch(generated, /readonly "(src|tests|pages|_limits)"/);
  succeeds(command(["check", "--no-script", "--project", "tsconfig.json"]), "app type graph");
  succeeds(command(["check", "--no-script", "--project", "tsconfig.tools.json"]), "Node tooling graph");

  // Acceptance: shared compiler composition retains ORIGINAL TSX and backend
  // mappings, including the backend map's relocation into final app/dist.
  await assertOriginalMapping(join(fixture, "dist/ui.js"), join(fixture, "src/pages/todos.tsx"), [
    ["First view", 'name="First view"'], ["New task", 'label="New task"'],
  ]);
  await assertOriginalMapping(join(fixture, "dist/bundle.js"), backend, [
    ["Enter a task title", 'throw new Error("Enter a task title")'],
  ]);
  const backendMap = JSON.parse(await readFile(join(fixture, "dist/bundle.js.map"), "utf8"));
  assert(backendMap.sources.some((source: string) => source === "../backend/todo.ts"),
    "final backend map must resolve from app/dist back to original backend source");

  // Failure mode: a previous successful dist must never disguise a missing
  // frontend, missing backend root, missing CSS, TSX parse or module error.
  await missing(frontend, () => rejects(build(), /main\.tsx|entry|resolve/i, "missing frontend"));
  await missing(join(fixture, "backend"), () =>
    rejects(build(), /backend|feature TypeScript modules/i, "missing backend"));
  await missing(join(fixture, "src/styles.css"), () =>
    rejects(build(), /styles\.css|ENOENT/i, "missing stylesheet"));
  await changed(frontend, "export const broken: = <div />;\n", () =>
    rejects(build(), /Unexpected token|Expected|Parse|Syntax/i, "invalid frontend TSX"));
  await changed(frontend, 'import "./missing-frontend-dependency";\n', () =>
    rejects(build(), /missing-frontend-dependency/, "missing frontend module"));
  const featureSource = await readFile(backend, "utf8");
  await changed(backend, `${featureSource}\nimport "./missing-backend-dependency";\n`, () =>
    rejects(build(), /missing-backend-dependency/, "missing backend module"));

  // Failure mode: Node build-tool ambient types must not leak into either
  // QuickJS graph. Frontend TS checking and SDK backend checking reject them.
  const frontendSource = await readFile(frontend, "utf8");
  await changed(frontend, `${frontendSource}\nconst forbidden = window.location;\n`, () =>
    rejects(command(["check", "--no-script", "--project", "tsconfig.json"]), /window|TS2304/,
      "frontend browser ambient leakage"));
  await changed(backend, `${featureSource}\nexport const forbidden = process.pid;\n`, () =>
    rejects(build(), /process|TS2580|TS2591/, "backend Node ambient leakage"));

  // Failure mode: Vite erases types, so the explicit checker must still reject
  // an invalid typed TSX program that the production transpiler can build.
  await changed(frontend,
    'import { mount } from "@tokamak/render";\nconst label: string = 42;\nmount(() => <p>{label}</p>);\n',
    () => {
      succeeds(build(), "Vite TS erasure");
      rejects(command(["check", "--no-script", "--project", "tsconfig.json"]), /TS2322/,
        "explicit frontend type check");
    });

  // Failure mode: real SSR and browser runtime imports must hit the shared
  // production guard, not merely produce a bundle that fails later in QuickJS.
  await changed(frontend,
    'import { createSignal } from "solid-js/dist/server.js";\nimport { mount } from "@tokamak/render";\nconst [label] = createSignal("SSR");\nmount(() => <p>{label()}</p>);\n',
    () => rejects(build(), /Expected Solid production client runtime|Browser\/dev runtime leaked/,
      "SSR runtime guard"));
  await changed(frontend,
    'import { render } from "solid-js/web";\nrender(() => null, {} as HTMLElement);\n',
    () => rejects(build(), /Expected Solid production client runtime|Browser\/dev runtime leaked/,
      "browser DOM runtime guard"));

  succeeds(build(), "restored zero-option production build");
  console.log("PASS zero-option compiler: root/app/spaced cwd, generated shell/CSS, maps, errors, guards and ambient types");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
