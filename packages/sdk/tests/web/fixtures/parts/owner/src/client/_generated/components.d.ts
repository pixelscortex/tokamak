// Generated plugin component paths. Commit this file.
export * from "../api";
declare const _part_Composer: import("@tokamak/sdk/client").ComponentParts<(typeof import("../api"))["Composer"], {
  readonly "sendButton": { readonly target: "owner.composer.sendButton"; readonly locked: false };
  readonly "toolbar": { readonly target: "owner.composer.toolbar"; readonly locked: false };
}>;
export { _part_Composer as Composer };
declare const _part_CustomLayout: import("@tokamak/sdk/client").ComponentParts<(typeof import("../api"))["CustomLayout"], {
  readonly "ribbon": { readonly target: "owner.customLayout.ribbon"; readonly locked: false };
}>;
export { _part_CustomLayout as CustomLayout };
declare const _part_Labels: import("@tokamak/sdk/client").ComponentParts<(typeof import("../api"))["Labels"], {
  readonly "body": { readonly target: "owner.labels.body"; readonly locked: false };
  readonly "for": { readonly target: "owner.labels.for"; readonly locked: false };
  readonly "region": { readonly target: "owner.labels.region"; readonly locked: false };
  readonly "search": { readonly target: "owner.labels.search"; readonly locked: false };
}>;
export { _part_Labels as Labels };
