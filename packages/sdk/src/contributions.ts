/** Identity helpers keep ordinary component exports usable across plugins.
 * The compiler reads the brand and literal options without executing UI code. */
export const contributionBrand: unique symbol = Symbol("tokamak.contribution");
export interface ContributionOptions {
  fill: { target: string; order?: number; fillId?: string };
  wrap: { target: string };
  replace: { target: string };
  view: { route: string };
  itemRenderer: { type: string };
  toolbar: { label: string };
  command: { title: string };
  entityCard: { table: string };
}
export type ContributionKind = keyof ContributionOptions;
export type Contribution<K extends ContributionKind, T> = T & {
  readonly [contributionBrand]: K;
  readonly options: ContributionOptions[K];
};
function helper<K extends ContributionKind>(kind: K) {
  return <T extends (...args: never[]) => unknown>(
    options: ContributionOptions[K],
    component: T,
  ): Contribution<K, T> => Object.assign(component, { [contributionBrand]: kind, options });
}
export const view = helper("view");
export const itemRenderer = helper("itemRenderer");
export const toolbar = helper("toolbar");
export const command = helper("command");
export const entityCard = helper("entityCard");
