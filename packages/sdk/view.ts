import type { JSX } from "@solidjs/web";

const viewBrand: unique symbol = Symbol("tokamak.view");

export interface ViewOptions {
  readonly route: string;
  readonly title?: string;
  /** Single-colour SVG path in a 24 × 24 box for a page in the rail. */
  readonly icon?: string;
}

/** Declare a page. Compose it with components to expose extensible elements. */
export function view<T extends (...args: never[]) => JSX.Element>(
  options: ViewOptions,
  render: T,
): T & {
  readonly [viewBrand]: string;
} {
  return Object.assign(render, { [viewBrand]: options.route });
}

/** Route declared by a loaded page export. */
export function viewRoute(value: unknown): string | undefined {
  return typeof value === "function" && viewBrand in value && typeof value[viewBrand] === "string"
    ? value[viewBrand]
    : undefined;
}
