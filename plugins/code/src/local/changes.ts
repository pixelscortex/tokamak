import type { Id, LocalContext } from "@tokamak/sdk";
import { readGit, readGitUntil, threadRefs, turnRefs, type Repository } from "./git";

/** What one turn changed in the thread's folder: "after" minus "before". */
export interface TurnChange {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
  /**
   * Set on the thread's first snapshot when an earlier turn ran without Git:
   * the number of files in the folder when tracking started. Null otherwise.
   */
  readonly tracking: number | null;
}

/** One changed file. Counts are 0 for a binary file. Paths are relative to the thread's folder. */
export interface ChangedFile {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly binary: boolean;
}

export interface FileDiff extends ChangedFile {
  /**
   * The file's hunks as Git prints them, from the first `@@` line, without
   * colour. Null when the panel's line budget ran out before this file.
   */
  readonly patch: readonly string[] | null;
  /** True for the one file the budget cut part-way: `patch` holds only its first lines. */
  readonly partial: boolean;
  /** A change with no lines to show: a binary file, a mode change, an empty file added or deleted. */
  readonly note: string | null;
}

export interface TurnDiff {
  readonly files: readonly FileDiff[];
  readonly added: number;
  readonly removed: number;
  /** True when the diff was cut at `DIFF_LINE_LIMIT` hunk lines. */
  readonly cut: boolean;
}

/** The most hunk lines (`@@` headers and code) the review panel loads for one turn; the rest is listed, not shown. */
export const DIFF_LINE_LIMIT = 3000;
/** A longer line (minified code, data) is cut to this many characters and ends with "…". */
const DIFF_LINE_CHARS = 400;

type Turn = Repository & { threadId: Id<"threads">; turnId: string };

// Plumbing, so the person's diff settings (external tools, colour, renames) never apply.
function diffArgs({ prefix }: Repository, before: string, after: string, extra: string[]): string[] {
  return [
    "diff-tree",
    "-r",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    ...(prefix ? [`--relative=${prefix}/`] : []),
    ...extra,
    before,
    after,
  ];
}

/** The before and after commits of a turn, or undefined when either was never saved. */
async function snapshots(ctx: LocalContext, turn: Turn) {
  const prefix = turnRefs(turn.threadId, turn.turnId);
  const found = new Map<string, string>();
  for (const line of await readGit(ctx, turn.root, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    `${prefix}/`,
  ])) {
    const [ref, commit] = line.split(" ");
    if (ref && commit) found.set(ref, commit);
  }
  const before = found.get(`${prefix}/before`);
  const after = found.get(`${prefix}/after`);
  return before && after ? { before, after } : undefined;
}

/** `git diff --numstat -z` rows: added, removed and path, NUL-terminated. */
async function changedFiles(ctx: LocalContext, turn: Turn, before: string, after: string) {
  const output = (await readGit(ctx, turn.root, diffArgs(turn, before, after, ["--numstat", "-z"]))).join(
    "\n",
  );
  const files: ChangedFile[] = [];
  for (const record of output.split("\0")) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(record);
    if (!match) continue;
    const binary = match[1] === "-";
    files.push({
      path: match[3]!,
      added: binary ? 0 : Number(match[1]),
      removed: binary ? 0 : Number(match[2]),
      binary,
    });
  }
  return files;
}

function sum(files: readonly ChangedFile[], key: "added" | "removed"): number {
  return files.reduce((total, file) => total + file[key], 0);
}

/**
 * The turn's counts for its change card. `ranEarlier` are the thread's earlier
 * turns whose agent ran: when one of them has no snapshot (it ran without Git)
 * and this turn's snapshot starts the thread's chain, tracking started here.
 */
export async function turnChange(
  ctx: LocalContext,
  turn: Turn,
  ranEarlier: readonly string[],
): Promise<TurnChange | null> {
  const saved = await snapshots(ctx, turn);
  if (!saved) return null;
  const files = await changedFiles(ctx, turn, saved.before, saved.after);
  const tracking =
    (await ranWithoutGit(ctx, turn, ranEarlier)) && (await startsChain(ctx, turn, saved.before))
      ? await fileCount(ctx, turn, saved.before)
      : null;
  return { files: files.length, added: sum(files, "added"), removed: sum(files, "removed"), tracking };
}

/** Whether any of `turnIds` has no snapshot ref in this thread. */
async function ranWithoutGit(ctx: LocalContext, turn: Turn, turnIds: readonly string[]): Promise<boolean> {
  if (!turnIds.length) return false;
  const saved = new Set(
    await readGit(ctx, turn.root, [
      "for-each-ref",
      "--format=%(refname)",
      `${threadRefs(turn.threadId)}/turns/`,
    ]),
  );
  return turnIds.some(
    (turnId) =>
      !saved.has(`${turnRefs(turn.threadId, turnId)}/before`) &&
      !saved.has(`${turnRefs(turn.threadId, turnId)}/after`),
  );
}

/** Whether `before` is the thread's first snapshot: its parent is not another snapshot of the thread. */
async function startsChain(ctx: LocalContext, turn: Turn, before: string): Promise<boolean> {
  const [, parent] =
    (await readGit(ctx, turn.root, ["rev-list", "--parents", "-1", before]))[0]?.split(" ") ?? [];
  if (!parent) return true;
  const snapshots = await readGit(ctx, turn.root, [
    "for-each-ref",
    "--format=%(objectname)",
    `${threadRefs(turn.threadId)}/turns/`,
  ]);
  return !snapshots.includes(parent);
}

async function fileCount(ctx: LocalContext, turn: Turn, commit: string): Promise<number> {
  const scope = turn.prefix ? ["--", `:(top,literal)${turn.prefix}/`] : [];
  const output = (
    await readGit(ctx, turn.root, ["ls-tree", "-r", "-z", "--name-only", commit, ...scope])
  ).join("\n");
  return output.split("\0").filter(Boolean).length;
}

type Section = { lines: string[]; header: string[]; inHunks: boolean };

/** What to say for a file whose change has no lines to show. */
function noteFor(file: ChangedFile, section: Section | undefined): string | null {
  if (file.binary) return "Binary file";
  const header = section?.header ?? [];
  const mode = (name: string) => header.find((line) => line.startsWith(name))?.slice(name.length);
  const from = mode("old mode ");
  const to = mode("new mode ");
  if (from && to) return `Mode changed from ${from} to ${to}`;
  if (section?.lines.length) return null;
  if (mode("new file mode ")) return "New empty file";
  if (mode("deleted file mode ")) return "Empty file deleted";
  return null;
}

/**
 * The turn's files with counts and their plain diffs, as `git diff before after`
 * shows them. At most `DIFF_LINE_LIMIT` hunk lines are read; the file being
 * read then is marked partial, and files after it keep their counts and get no patch.
 */
export async function turnDiff(ctx: LocalContext, turn: Turn): Promise<TurnDiff | null> {
  const saved = await snapshots(ctx, turn);
  if (!saved) return null;
  const files = await changedFiles(ctx, turn, saved.before, saved.after);
  // Sections come in the same order as the numstat rows: one per `diff --git` header.
  const sections: Section[] = [];
  let budget = DIFF_LINE_LIMIT;
  const complete = await readGitUntil(
    ctx,
    turn.root,
    diffArgs(turn, saved.before, saved.after, ["-p", "--no-color"]),
    (line) => {
      const current = sections.at(-1);
      // A code line can start with "diff --git " only after its +, - or space.
      if (line.startsWith("diff --git ")) sections.push({ lines: [], header: [], inHunks: false });
      else if (current && (current.inHunks || line.startsWith("@@"))) {
        if (budget === 0) return false;
        budget--;
        current.inHunks = true;
        current.lines.push(line.length > DIFF_LINE_CHARS ? `${line.slice(0, DIFF_LINE_CHARS)}…` : line);
      } else current?.header.push(line);
      return true;
    },
  );
  const cutAt = complete ? -1 : sections.length - 1;
  return {
    files: files.map((file, index) => {
      const section = sections[index];
      const shown = !!section && (index !== cutAt || section.lines.length > 0);
      return {
        ...file,
        patch: shown ? section.lines : null,
        partial: index === cutAt && shown,
        note: shown ? noteFor(file, section) : null,
      };
    }),
    added: sum(files, "added"),
    removed: sum(files, "removed"),
    cut: !complete,
  };
}

/** The checked-out branch, or the short commit when HEAD is detached. */
export async function currentBranch(ctx: LocalContext, { root }: Repository): Promise<string> {
  const [name] = await readGit(ctx, root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => []);
  if (name) return name;
  const [commit] = await readGit(ctx, root, ["rev-parse", "--short", "HEAD"]);
  return commit ?? "HEAD";
}
