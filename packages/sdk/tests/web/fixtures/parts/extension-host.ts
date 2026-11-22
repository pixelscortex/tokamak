import type { ExtensionContribution, ExtensionHost } from "../../../../client";

export type Layer = { export: unknown; metadata: ExtensionContribution };

export function layer(
  id: string,
  value: unknown,
  action: string,
  target: { target: string },
  order = 0,
  plugin = "addon",
  installOrder = 0,
): Layer {
  return {
    export: value,
    metadata: {
      plugin,
      id,
      kind: "component-action",
      options: { action, target: target.target, order },
      installOrder,
    },
  };
}

export function host(layers: Layer[]): ExtensionHost {
  return {
    contributions: (kind) =>
      layers.filter(({ metadata }) => metadata.kind === kind).map(({ metadata }) => metadata),
    version: () => 0,
    load: async (plugin) =>
      Object.fromEntries(
        layers.filter(({ metadata }) => metadata.plugin === plugin).map((l) => [l.metadata.id, l.export]),
      ),
    onError: () => () => {},
  };
}
