// Generated plugin screen search types. Commit this file.
export * from "../api";
type Props1 = Extract<NonNullable<Parameters<typeof import("../api")["FixtureBody"]>[0]>, object>;
type Props2 = Extract<NonNullable<import("@tokamak/sdk/client").ElementAttributes<"section">>, object>;
type Props3 = Extract<NonNullable<import("@tokamak/sdk/client").ElementAttributes<"h1">>, object>;
type Props4 = Extract<NonNullable<import("@tokamak/sdk/client").ElementAttributes<"p">>, object>;
type Props5 = Extract<NonNullable<import("@solidjs/web").ComponentProps<typeof import("../view").FixtureBody>>, object>;
export declare const find: import("@tokamak/sdk/client").ScreenFind<{
  "section": [["FixtureBody", Props1, undefined, Props2]];
  "h1": [["FixtureBody" | "section", Props1, undefined, Props3]];
  "p": [["FixtureBody" | "section", Props1, undefined, Props4]];
  "FixtureBody": [["FixtureView", {}, undefined, Props5]];
}>;
