// Generated plugin screen search types. Commit this file.
export * from "../api";
type Props1 = Extract<NonNullable<import("@tokamak/sdk/client").ElementAttributes<"small">>, object>;
type Props2 = Extract<NonNullable<import("@tokamak/sdk/client").ElementAttributes<"p">>, object>;
type Props3 = Extract<NonNullable<import("@tokamak/sdk/client").ElementAttributes<"div">>, object>;
export declare const find: import("@tokamak/sdk/client").ScreenFind<{
  "small": [[never, {}, undefined, Props1], [never, {}, undefined, Props1], [never, {}, undefined, Props1], [never, {}, undefined, Props1]];
  "p": [[never, {}, undefined, Props2]];
  "div": [[never, {}, {"aria":{"label":"replacement"}}, Props3]];
}>;
