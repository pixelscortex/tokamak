export const searchAttributes = ["type", "href", "role"] as const;
type SearchAttribute = (typeof searchAttributes)[number];

export type AttributeFilters = Partial<Record<SearchAttribute, string>> & {
  aria?: Readonly<Record<string, string>>;
};
export type ScreenSearch = AttributeFilters & { name: string; in?: string; nth?: number };
export type ScreenElement = { target: string; fingerprint?: string };
export type ScreenTarget = ScreenElement & { search?: ScreenSearch };
type ScreenKind = "element" | "render function";
type Candidate = ScreenElement & {
  name: string;
  ancestors: readonly string[];
  attributes?: Readonly<Record<string, string>>;
  computed?: readonly string[];
};

export function isSearchAttribute(name: string): name is SearchAttribute {
  return searchAttributes.some((key) => key === name);
}

export function isAriaAttribute(name: string) {
  return name.startsWith("aria-") && name.length > 5;
}

export function flattenAttributes(filters: AttributeFilters) {
  const attributes: [string, string][] = [];
  for (const name of searchAttributes) {
    const value = filters[name];
    if (value !== undefined) attributes.push([name, value]);
  }
  for (const [name, value] of Object.entries(filters.aria ?? {})) attributes.push([`aria-${name}`, value]);
  return attributes;
}

export function attributeFilters(options: Readonly<Record<string, string | number>>) {
  const filters: AttributeFilters = {};
  const aria: [string, string][] = [];
  for (const [name, value] of Object.entries(options)) {
    if (typeof value !== "string") continue;
    if (isSearchAttribute(name)) filters[name] = value;
    else if (isAriaAttribute(name)) aria.push([name.slice(5), value]);
  }
  if (aria.length) filters.aria = Object.fromEntries(aria);
  return filters;
}

// Ordered pairs preserve source order even for names like "123". Leaves hold
// just a fingerprint (or null); branches use "" for their own fingerprint.
// With attributes, that fingerprint becomes [fingerprint, name, value, …].
// A leading ":" at the root marks trees with render function addresses.
// Inside, branches with no "" or ":" entry are render functions. A ":" entry
// marks a scope that only encloses other functions and cannot be attached to.
export type ScreenTree = readonly (string | null | ScreenTree)[];

function segmentName(segment: string) {
  // Consume escapes before looking for a positional suffix. For example, the
  // closing dollar in "$24$2" belongs to the encoded name "$2".
  return segment.replace(
    /\$([\da-f]+)\$|\$\d+$|^\$(?=(?:target|fingerprint|__proto__|constructor|prototype)(?:\$\d+)?$)/g,
    (_, hex: string | undefined) => (hex ? String.fromCharCode(parseInt(hex, 16)) : ""),
  );
}

export function screenElements(plugin: string, tree: ScreenTree, kind: ScreenKind = "element") {
  const elements: Candidate[] = [];
  const functions = kind === "render function";
  if (functions && tree[0] !== ":") return elements; // Older bundles have no instance hook.
  function visit(branch: ScreenTree, target: string, ancestors: readonly string[]) {
    if (functions && branch[0] !== "" && branch[0] !== ":")
      elements.push({ target, name: ancestors.at(-1)!, ancestors: ancestors.slice(0, -1) });
    for (let i = 0; i < branch.length; i += 2) {
      const segment = branch[i] as string;
      const value = branch[i + 1]!;
      if (segment === ":") continue;
      if (segment === "") {
        if (functions) continue;
        const packed = typeof value === "object" && value !== null ? value : undefined;
        let attributes: Record<string, string> | undefined;
        if (packed) {
          attributes = {};
          for (let j = 1; j < packed.length; j += 2)
            attributes[packed[j] as string] = packed[j + 1] as string;
        }
        const fingerprint = packed ? packed[0] : value;
        elements.push({
          target,
          name: ancestors.at(-1)!,
          ancestors: ancestors.slice(0, -1),
          fingerprint: typeof fingerprint === "string" ? fingerprint : undefined,
          attributes,
        });
      } else {
        const name = segmentName(segment);
        const path = `${target}.${segment}`;
        if (typeof value === "string" || value === null) {
          if (!functions) elements.push({ target: path, name, ancestors, fingerprint: value ?? undefined });
        } else visit(value, path, [...ancestors, name]);
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
            ...attributeFilters(options),
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
  kind: ScreenKind = "element",
): { element: ScreenElement; reason?: never } | { element?: never; reason: string } {
  if (!search) {
    const samePath = elements.find((element) => element.target === previous?.target);
    if (!samePath) return { reason: `targets missing screen part ${previous?.target}` };
    if (previous?.fingerprint && previous.fingerprint !== samePath.fingerprint)
      return { reason: `targets a different ${kind} at ${previous.target}` };
    return { element: samePath };
  }

  const { name, in: within, nth } = search;
  const named = elements.filter((element) => element.name === name);
  const attributes = flattenAttributes(search);
  const scoped = named.filter(
    (element) =>
      (within === undefined || element.ancestors.includes(within)) &&
      attributes.every(([key, value]) => element.attributes?.[key] === value),
  );
  const matches = nth === undefined ? scoped : scoped.slice(nth - 1, nth);
  // A name says which element is meant, so a search without `nth` follows it
  // wherever the owner moves it. Only a position can come to mean another
  // element: an `nth` search stays on the element it found, or is skipped.
  const pinned = !!previous && nth !== undefined;
  const retained =
    previous &&
    matches.find(
      (element) =>
        element.target === previous.target &&
        (!pinned || !previous.fingerprint || previous.fingerprint === element.fingerprint),
    );
  if (retained) return { element: retained };
  if (!pinned && matches.length === 1) return { element: matches[0]! };

  const issue =
    matches.length === 0
      ? `matches no ${kind}s`
      : pinned
        ? `targets a different ${kind}`
        : `matches several ${kind}s`;
  return { reason: searchProblem(search, issue, scoped.length ? scoped : named) };
}

export function describeScreenSearch(search: ScreenSearch) {
  const aria = Object.entries(search.aria ?? {})
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(", ");
  const filters = [
    search.in === undefined ? undefined : `in: ${JSON.stringify(search.in)}`,
    ...searchAttributes.flatMap((key) =>
      search[key] === undefined ? [] : [`${key}: ${JSON.stringify(search[key])}`],
    ),
    aria ? `aria: { ${aria} }` : undefined,
    search.nth === undefined ? undefined : `nth: ${search.nth}`,
  ].filter(Boolean);
  return `find(${JSON.stringify(search.name)}${filters.length ? `, { ${filters.join(", ")} }` : ""})`;
}

export function unnamedTargetWarning(plugin: string, search: ScreenSearch, target: string) {
  return `Plugin "${plugin}": ${describeScreenSearch(search)} targets unnamed element ${target}; add data-part to name this element`;
}

function searchProblem(search: ScreenSearch, issue: string, options: readonly Candidate[]) {
  const filters = flattenAttributes(search);
  const labels = options.map(({ ancestors, name, attributes, computed }) => {
    const path = [...ancestors, name].join(" › ");
    if (!filters.length) return path;
    const details = [
      ...Object.entries(attributes ?? {}).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
      ...(computed ?? []).map((key) => `${key}={…} (a filter cannot match a computed value)`),
    ];
    return details.length ? `${path} [${details.join(", ")}]` : `${path} [no static filter attributes]`;
  });
  const candidates =
    labels
      .map((label, index) =>
        labels.indexOf(label) === labels.lastIndexOf(label) ? label : `${label} (match ${index + 1})`,
      )
      .join(", ") || "none";
  return `${describeScreenSearch(search)} ${issue}; candidates: ${candidates}. Narrow the search with in or nth`;
}
