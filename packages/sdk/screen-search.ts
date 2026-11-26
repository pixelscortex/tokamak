export type ScreenSearch = { name: string; in?: string; nth?: number };
export type ScreenElement = { target: string; fingerprint?: string };
export type ScreenTarget = ScreenElement & { search?: ScreenSearch };
type Candidate = ScreenElement & { name: string; ancestors: readonly string[] };

// Ordered pairs preserve source order even for names like "123". Leaves hold
// just a fingerprint (or null); branches use "" for their own fingerprint.
export type ScreenTree = readonly (string | null | ScreenTree)[];

function segmentName(segment: string) {
  // Consume escapes before looking for a positional suffix. For example, the
  // closing dollar in "$24$2" belongs to the encoded name "$2".
  return segment.replace(
    /\$([\da-f]+)\$|\$\d+$|^\$(?=(?:target|fingerprint|__proto__|constructor|prototype)(?:\$\d+)?$)/g,
    (_, hex: string | undefined) => (hex ? String.fromCharCode(parseInt(hex, 16)) : ""),
  );
}

export function screenElements(plugin: string, tree: ScreenTree) {
  const elements: Candidate[] = [];
  function visit(branch: ScreenTree, target: string, ancestors: readonly string[]) {
    for (let i = 0; i < branch.length; i += 2) {
      const segment = branch[i] as string;
      const value = branch[i + 1]!;
      if (segment === "") {
        elements.push({
          target,
          name: ancestors.at(-1)!,
          ancestors: ancestors.slice(0, -1),
          fingerprint: typeof value === "string" ? value : undefined,
        });
      } else {
        const name = segmentName(segment);
        const path = `${target}.${segment}`;
        if (typeof value === "string" || value === null)
          elements.push({ target: path, name, ancestors, fingerprint: value ?? undefined });
        else visit(value, path, [...ancestors, name]);
      }
    }
  }
  visit(tree, plugin, []);
  return elements;
}

export function screenTarget(options: Readonly<Record<string, string | number>>): ScreenTarget {
  const { target, fingerprint, name, in: within, nth } = options;
  return {
    target: String(target),
    fingerprint: typeof fingerprint === "string" ? fingerprint : undefined,
    search:
      typeof name === "string"
        ? {
            name,
            in: typeof within === "string" ? within : undefined,
            nth: typeof nth === "number" ? nth : undefined,
          }
        : undefined,
  };
}

export function resolveScreenSearch(
  elements: readonly Candidate[],
  search?: ScreenSearch,
  previous?: ScreenElement,
): { element: ScreenElement; reason?: never } | { element?: never; reason: string } {
  if (!search) {
    const samePath = elements.find((element) => element.target === previous?.target);
    if (!samePath) return { reason: `targets missing screen part ${previous?.target}` };
    if (previous?.fingerprint && previous.fingerprint !== samePath.fingerprint)
      return { reason: `targets a different element at ${previous.target}` };
    return { element: samePath };
  }

  const { name, in: within, nth } = search;
  const named = elements.filter((element) => element.name === name);
  const scoped = within === undefined ? named : named.filter((element) => element.ancestors.includes(within));
  const matches = nth === undefined ? scoped : scoped.slice(nth - 1, nth);
  const guarded = !!previous && (previous.fingerprint !== undefined || nth !== undefined);
  const retained =
    previous &&
    matches.find(
      (element) =>
        element.target === previous.target && (!guarded || previous.fingerprint === element.fingerprint),
    );
  if (retained) return { element: retained };
  if (!guarded && matches.length === 1) return { element: matches[0]! };

  const issue =
    matches.length === 0
      ? "matches no elements"
      : guarded
        ? "targets a different element"
        : "matches several elements";
  return { reason: searchProblem(search, issue, scoped.length ? scoped : named) };
}

function searchProblem(search: ScreenSearch, issue: string, options: readonly Candidate[]) {
  const labels = options.map(({ ancestors, name }) => [...ancestors, name].join(" › "));
  const candidates =
    labels
      .map((label, index) =>
        labels.indexOf(label) === labels.lastIndexOf(label) ? label : `${label} (match ${index + 1})`,
      )
      .join(", ") || "none";
  const filters = [
    search.in === undefined ? undefined : `in: ${JSON.stringify(search.in)}`,
    search.nth === undefined ? undefined : `nth: ${search.nth}`,
  ].filter(Boolean);
  const description = `find(${JSON.stringify(search.name)}${filters.length ? `, { ${filters.join(", ")} }` : ""})`;
  return `${description} ${issue}; candidates: ${candidates}. Narrow the search with in or nth`;
}
