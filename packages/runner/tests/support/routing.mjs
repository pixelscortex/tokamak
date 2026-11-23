import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { within } from "../../../../e2e/fake-agent/harness.mjs";

const hash = (code) => createHash("sha256").update(code).digest("hex");

export async function editBundle(dist, extra, transform = (code) => code) {
  const file = join(dist, "local.js");
  const code = transform(await readFile(file, "utf8")) + "\n" + extra;
  const path = join(dist, "manifest.json");
  const manifest = await Bun.file(path).json();
  manifest.hashes["local.js"] = hash(code);
  await writeFile(file, code);
  await writeFile(path, JSON.stringify(manifest));
}

export async function installLocal(folder, id, code) {
  await mkdir(folder, { recursive: true });
  const artifact = { id, entryHash: hash(""), codeHash: hash(code) };
  await Promise.all([
    writeFile(join(folder, "local-entry.js"), ""),
    writeFile(join(folder, "local.js"), code),
    writeFile(
      join(folder, "manifest.json"),
      JSON.stringify({
        plugin: { id, version: "1.0.0" },
        entries: { local: { entry: "local-entry.js", code: "local.js" } },
        hashes: { "local-entry.js": artifact.entryHash, "local.js": artifact.codeHash },
      }),
    ),
  ]);
  return artifact;
}

export async function inspectHosts({ endpoint: { http, token } }) {
  const { pid } = await (
    await fetch(http + "/health", { headers: { Authorization: "Bearer " + token } })
  ).json();
  return () => {
    const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,state=,command="]).stdout.toString();
    return ps.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+.*tokamak-plugin-host --local-plugin (\S+) /.exec(line);
      return match && Number(match[2]) === pid && !match[3].startsWith("Z")
        ? [{ id: match[4], pid: Number(match[1]) }]
        : [];
    });
  };
}

export async function until(description, predicate, ms = 10_000) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out: ${description}`);
}

export async function reload({ endpoint: { http } }, directory, id) {
  const control = (await readFile(join(directory, "runner.control"), "utf8")).trim();
  const response = await fetch(http + "/plugins/" + id + "/reload", {
    method: "POST",
    headers: { Authorization: "Bearer " + control },
  });
  assert.equal(response.status, 200, await response.text());
}

/** A protocol client for tests that need explicit versions or nested routes. */
export async function rawWindow(runner, artifact, handle, live = [], origin) {
  let next = 0;
  const calls = new Map();
  let worker;
  worker = await runner.launch(
    artifact,
    (frame) => {
      if (frame.type === "result") {
        const call = calls.get(frame.id);
        calls.delete(frame.id);
        if (frame.error) call?.reject(new Error(frame.error));
        else call?.resolve(frame.value);
        return;
      }
      const call = calls.get(frame.call);
      const respond = (value) => worker.send({ type: "opResult", id: frame.id, value });
      void Promise.resolve()
        .then(() => (frame.name === "auth.current" ? respond({}) : handle(frame, worker, respond)))
        .catch((error) => call?.reject(error));
    },
    (reason) => {
      for (const call of calls.values()) call.reject(new Error(reason));
    },
    live,
    origin,
  );
  return {
    close: () => worker.close(),
    retire: (changed) => worker.retire(artifact, live, changed),
    async invoke(fn, args) {
      const id = ++next;
      const result = Promise.withResolvers();
      calls.set(id, result);
      await worker.send({ type: "invoke", id, fn, args });
      return within(result.promise, fn);
    },
  };
}
