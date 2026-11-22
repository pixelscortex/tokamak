// Wire values shared by the function builders and the plugin compiler.
export const Visibility = {
  Public: "public",
  PluginOnly: "pluginOnly",
  Internal: "internal",
} as const;

export type Visibility = (typeof Visibility)[keyof typeof Visibility];
