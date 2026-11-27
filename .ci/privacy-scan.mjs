import assert from "node:assert/strict";
import { homedir, userInfo } from "node:os";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// The words and names this computer must never leak: the login, the home folder and
// TOKAMAK_PRIVATE_WORDS (comma-separated, set locally only; never write the words in the repo).
function localPrivacy() {
  const login = userInfo().username;
  // These logins are also normal words in prompts and source paths.
  const genericLogin = /^(?:user|root|runner)$/i.test(login);
  return {
    homePath: homedir().replaceAll("\\", "/").toLowerCase(),
    genericLogin,
    privateWords: (process.env.TOKAMAK_PRIVATE_WORDS ?? "")
      .split(",")
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean),
    loginPattern: genericLogin
      ? null
      : new RegExp(`(^|[^\\w.-])${login.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, "\\$&")}($|[^\\w.-])`, "i"),
  };
}

const repository = fileURLToPath(new URL("../", import.meta.url));
// Lockfiles name upstream sources and their owners; they are generated, not written by us.
const skippedFiles = new Set([
  "Cargo.lock",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "skills-lock.json",
]);
// Names the app had before these checks, matched by shape so the words never appear here.
// Each is removed from its line before the line is checked.
const allowedShapes = new Map([
  ["app/src-tauri/tauri.conf.json", [/"identifier": "com\.[\w-]+\.Tokamak"/g]],
  ["packages/server/src/main.rs", [/ProjectDirs::from\("com", "[\w-]+", name\)/g]],
  ["Cargo.toml", [/rquickjs-sys = \{ git = "https:\/\/github\.com\/[\w-]+\/rquickjs"/g]],
]);

/** Checks every tracked or new text file (tests, fixtures, docs) for the private words, the login
 *  and the home folder. */
export async function scanRepository(root = repository) {
  const { homePath, genericLogin, privateWords, loginPattern } = localPrivacy();
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file && !skippedFiles.has(basename(file)));
  assert.ok(files.length, "No repository files found");
  const issues = [];
  for (const file of new Set(files)) {
    let bytes;
    try {
      bytes = await readFile(join(root, file));
    } catch (cause) {
      if (cause.code === "ENOENT" || cause.code === "EISDIR") continue; // deleted, or a submodule
      throw cause;
    }
    if (bytes.includes(0)) continue; // binary
    const shapes = allowedShapes.get(file) ?? [];
    for (const [index, raw] of bytes.toString("utf8").split("\n").entries()) {
      const line = shapes.reduce((text, shape) => text.replace(shape, ""), raw);
      const lower = line.toLowerCase();
      const found = [
        loginPattern?.test(line) && "local login",
        privateWords.some((word) => lower.includes(word)) && "private word",
        // A shared home such as /root also appears in container files; only a personal one is private.
        !genericLogin && lower.replaceAll("\\", "/").includes(homePath) && "absolute home path",
      ].filter(Boolean);
      for (const issue of found) issues.push(`${file}:${index + 1}: ${issue}`);
    }
  }
  assert.ok(!issues.length, `Private data in the repository:\n${issues.join("\n")}`);
}

if (import.meta.main) await scanRepository();
