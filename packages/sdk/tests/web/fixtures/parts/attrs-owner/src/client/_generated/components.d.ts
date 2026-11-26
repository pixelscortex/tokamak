// Generated plugin screen search types. Commit this file.
export * from "../api";
type Props1 = Extract<NonNullable<{ disabled: boolean; label: string; mount: () => void; optional?: () => void }>, object>;
type Props2 = Extract<NonNullable<Parameters<typeof import("../api")["AttributeScreen"]>[0]>, object>;
type Props3 = Extract<NonNullable<Props2 & { readonly $row: { readonly item: string; readonly index: () => number } }>, object>;
type Props4 = Extract<NonNullable<import("@tokamak/sdk/client").ElementAttributes<"button">>, object>;
type Props5 = Extract<NonNullable<import("@tokamak/sdk/client").ElementAttributes<"main">>, object>;
type Props6 = Extract<NonNullable<import("@tokamak/sdk/client").ElementAttributes<"article">>, object>;
type Props7 = Extract<NonNullable<import("@tokamak/sdk/client").ElementAttributes<"header">>, object>;
type Props8 = Extract<NonNullable<import("@tokamak/sdk/client").ElementAttributes<"input">>, object>;
type Props9 = Extract<NonNullable<import("@tokamak/sdk/client").ElementAttributes<"em">>, object>;
export declare const find: import("@tokamak/sdk/client").ScreenFind<{
  "button": [["AttrButton", Props1, undefined, Props4]];
  "main": [["AttributeScreen", Props2, undefined, Props5]];
  "attr-root": [["AttributeScreen" | "main", Props2, undefined, Props6]];
  "attr-nested": [["AttributeScreen" | "main" | "attr-root", Props2, undefined, Props7]];
  "attr-input": [["AttributeScreen" | "main" | "attr-root", Props2, {"type":"text"}, Props8]];
  "AttrButton": [["AttributeScreen" | "main" | "attr-root", Props2, undefined, Props1]];
  "attr-row": [["AttributeScreen" | "main", Props3, undefined, Props9]];
}>;
