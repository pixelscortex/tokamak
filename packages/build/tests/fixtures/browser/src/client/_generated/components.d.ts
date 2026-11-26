// Generated plugin screen search types. Commit this file.
export * from "../api";
type Props1 = Extract<NonNullable<Parameters<typeof import("../api")["FixtureBody"]>[0]>, object>;
export declare const find: import("@tokamak/sdk/client").ScreenFind<{
  "section": Props1;
  "h1": Props1;
  "p": Props1;
  "FixtureBody": {};
}, {
  "FixtureBody": [[never, Props1]];
  "FixtureView": [[never, {}]];
}>;
