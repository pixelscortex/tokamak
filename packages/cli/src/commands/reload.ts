import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { CommandError, type Command } from "../command";
import { acquireLock, readIndex } from "../plugin-index";
import { ServerRefusal, serverGet, serverPost } from "../server";
import { buildInFolder } from "./build";

type Build = { id: string; buildId: string; depends: string[] };
type Result = {
  id: string;
  buildId: string | null;
  status: "loaded" | "unchanged" | "build-failed" | "load-failed" | "unknown";
  error?: { message: string; diagnostics?: object[] };
};
type Catalog = {
  plugins: { plugin: { id: string }; revision: string; fromIndex?: boolean }[];
  unchanged?: string[];
  removed?: string[];
  skipped?: Record<string, string>;
  warnings?: string[];
};
type Report = {
  results: Map<string, Result>;
  removed: Set<string>;
  skipped: Record<string, string>;
  removalError?: string;
  warnings: Set<string>;
};

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const uncertain = "The reload outcome is not known; run tokamak plugin list";

function failed(
  id: string,
  buildId: string | null,
  status: "build-failed" | "load-failed" | "unknown",
  cause: unknown,
): Result {
  const diagnostics = cause instanceof CommandError ? cause.diagnostics : undefined;
  return { id, buildId, status, error: { message: messageOf(cause), ...(diagnostics && { diagnostics }) } };
}

async function build(id: string, folder: string): Promise<Build> {
  const { data } = await buildInFolder(folder);
  if (data.id !== id) throw new Error(`Build produced plugin ${data.id}, expected ${id}`);
  const bytes = await readFile(join(data.outputFolder, "manifest.json"));
  return {
    id,
    buildId: createHash("sha256").update(bytes).digest("hex"),
    depends: Object.keys(JSON.parse(bytes.toString()).plugin.depends ?? {}),
  };
}

function applyAnswer(report: Report, builds: Build[], answer: Catalog, reconciled: boolean) {
  const running = new Map(answer.plugins.map(({ plugin, revision }) => [plugin.id, revision]));
  report.skipped = answer.skipped ?? {};
  for (const id of answer.removed ?? []) report.removed.add(id);
  for (const warning of answer.warnings ?? []) report.warnings.add(warning);
  for (const { id, buildId } of builds) {
    const skipped = Object.hasOwn(report.skipped, id) ? report.skipped[id] : undefined;
    if (skipped || running.get(id) !== buildId) {
      report.results.set(
        id,
        failed(id, buildId, "load-failed", skipped ?? "The server did not apply this build"),
      );
    } else {
      const status = !reconciled && answer.unchanged?.includes(id) ? "unchanged" : "loaded";
      report.results.set(id, { id, buildId, status });
    }
  }
}

async function runningCatalog(server?: string): Promise<Catalog> {
  const answer = (await serverGet("/plugins", server)) as Catalog;
  if (!Array.isArray(answer?.plugins)) throw new Error("Server returned an invalid catalog");
  return answer;
}

function indexedIds(catalog: Catalog) {
  return catalog.plugins.filter(({ fromIndex }) => fromIndex).map(({ plugin }) => plugin.id);
}

async function reconcileRemovals(report: Report, before: Catalog | undefined, after: Catalog) {
  const index = await readIndex();
  const current = new Set(indexedIds(after));
  if ([...current].some((id) => !index.has(id))) {
    report.removalError = "The server did not apply every index removal";
  }
  for (const id of before ? indexedIds(before) : []) {
    if (!current.has(id) && !index.has(id)) report.removed.add(id);
  }
}

async function submit(report: Report, builds: Build[], removeMissing: boolean, server?: string) {
  const payload = { builds: builds.map(({ id, buildId }) => ({ id, buildId })), removeMissing };
  const before = removeMissing ? await runningCatalog(server).catch(() => undefined) : undefined;
  let answer: Catalog;
  try {
    answer = (await serverPost("/plugin-index/reload", payload, server)) as Catalog;
    if (!Array.isArray(answer?.plugins)) throw new Error("Server returned an invalid reload answer");
  } catch (error) {
    if (error instanceof ServerRefusal) throw error;
    try {
      const running = await runningCatalog(server);
      applyAnswer(report, builds, running, true);
      if (removeMissing)
        await reconcileRemovals(report, before, running).catch(() => {
          report.removalError = uncertain;
        });
    } catch {
      for (const { id, buildId } of builds) report.results.set(id, failed(id, buildId, "unknown", uncertain));
      if (removeMissing) report.removalError = uncertain;
    }
    return;
  }
  applyAnswer(report, builds, answer, false);
}

function dependencyOrder(builds: Build[]) {
  const pending = new Map(builds.map((build) => [build.id, build]));
  const ordered: Build[] = [];
  while (pending.size) {
    const ready = [...pending.values()].filter(({ depends }) => depends.every((id) => !pending.has(id)));
    if (!ready.length) return [...ordered, ...pending.values()];
    for (const build of ready) {
      pending.delete(build.id);
      ordered.push(build);
    }
  }
  return ordered;
}

async function retryBuilds(report: Report, builds: Build[], server?: string) {
  let pending = dependencyOrder(builds);
  while (pending.length) {
    const waiting: Build[] = [];
    let progress = false;
    for (const build of pending) {
      try {
        await submit(report, [build], false, server);
        progress ||= report.results.get(build.id)?.status === "loaded";
      } catch (error) {
        report.results.set(build.id, failed(build.id, build.buildId, "load-failed", error));
        if (/missing dependency/i.test(messageOf(error))) waiting.push(build);
      }
    }
    if (!progress) break;
    pending = waiting;
  }
}

async function applyBuilds(report: Report, builds: Build[], all: boolean, server?: string) {
  if (!builds.length && !all) return;
  try {
    await submit(report, builds, all, server);
  } catch (error) {
    if (!all || (error instanceof ServerRefusal && error.code === "index-backfill")) {
      if (all && !builds.length) report.removalError = messageOf(error);
      for (const { id, buildId } of builds) report.results.set(id, failed(id, buildId, "load-failed", error));
      return;
    }
    await retryBuilds(report, builds, server);
    try {
      await submit(report, [], true, server);
    } catch (removalError) {
      report.removalError = messageOf(removalError);
    }
  }
}

async function runReload(id: string | undefined, server?: string) {
  const index = await readIndex();
  if (id !== undefined && !index.has(id))
    throw new CommandError(`Unknown indexed plugin: ${id}`, "tokamak plugin add");
  const selected = id === undefined ? [...index] : [[id, index.get(id)!] as const];
  const report: Report = { results: new Map(), removed: new Set(), skipped: {}, warnings: new Set() };
  const releases = new Map<string, () => Promise<void>>();
  const builds: Build[] = [];
  try {
    // Take locks in folder order so overlapping reloads cannot deadlock.
    for (const [plugin, folder] of [...selected].sort((a, b) => a[1].localeCompare(b[1]))) {
      try {
        const canonical = await realpath(folder);
        if (!releases.has(canonical)) releases.set(canonical, await acquireLock(canonical, ".tokamak-build"));
        builds.push(await build(plugin, canonical));
      } catch (error) {
        report.results.set(plugin, failed(plugin, null, "build-failed", error));
      }
    }
    await applyBuilds(report, builds, id === undefined, server);
  } finally {
    await Promise.all([...releases.values()].map((release) => release()));
  }
  return reportOutput(
    report,
    selected.map(([plugin]) => plugin),
  );
}

function reportOutput(report: Report, selected: string[]) {
  const plugins = selected.map((id) => report.results.get(id)!);
  const removed = [...report.removed];
  const skipped = Object.fromEntries(Object.entries(report.skipped).filter(([id]) => !selected.includes(id)));
  const warnings = [...report.warnings];
  const data = { plugins, removed, skipped, ...(warnings.length && { warnings }) };
  const lines = [
    ...plugins.map(({ id, status, error }) =>
      error
        ? `${id}: ${error.message}${
            error.diagnostics
              ?.map((entry) => {
                const { file, line, column, code, message } = entry as Record<string, unknown>;
                return `\n${file ? `${file}:${line}:${column}: ` : ""}${code ? `${code}: ` : ""}${message}`;
              })
              .join("") ?? ""
          }`
        : `${id}: ${status}`,
    ),
    ...removed.map((id) => `Removed ${id} from the running index`),
    ...Object.entries(skipped).map(([id, reason]) => `Skipped ${id}: ${reason}`),
    ...warnings.map((warning) => `Warning: ${warning}`),
  ];
  if (report.removalError) lines.push(`Could not confirm index removals: ${report.removalError}`);
  const text = lines.join("\n") || "No indexed plugins to reload.";
  if (report.removalError || plugins.some(({ error }) => error))
    throw new CommandError(text, "tokamak plugin list", undefined, data);
  return { data, text };
}

export default {
  path: "plugin reload",
  summary: "Build and reload indexed plugins in the running local server.",
  args: { name: "id", optional: true },
  usesServer: true,
  example: "tokamak plugin reload my-plugin --json",
  async run([id], { server }) {
    return runReload(id, server);
  },
} satisfies Command;
