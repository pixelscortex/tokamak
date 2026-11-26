// Generated plugin screen search types. Commit this file.
export * from "../api";
type P1 = Extract<NonNullable<{
  disabled: boolean;
  label: string;
  once?: boolean;
  mount: () => void;
  optional?: () => void;
}>, object>;
type P2 = Extract<NonNullable<Parameters<typeof import("../api")["AttributeScreen"]>[0]>, object>;
type P3 = Extract<NonNullable<P2 & { readonly $row: { readonly item: string; readonly index: () => number } }>, object>;
export declare const find: import("@tokamak/sdk/client").ScreenFind<{
  "button": P1;
  "main": P2;
  "attr-root": P2;
  "attr-nested": P2;
  "attr-input": [["AttributeScreen" | "main" | "attr-root", P2, {"type":"text"}]];
  "AttrButton": P2;
  "attr-row": P3;
}, {
  "AttrButton": [[never, P1]];
  "AttributeScreen": [[never, P2]];
}, { "attr-root":"article"; "attr-nested":"header"; "attr-input":"input"; "AttrButton":P1; "attr-row":"em" }>;
