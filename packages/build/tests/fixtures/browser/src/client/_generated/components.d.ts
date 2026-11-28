// Generated plugin screen search types. Commit this file.
export * from "../api";
type P1 = Extract<NonNullable<Parameters<typeof import("../api")["FixtureBody"]>[0]>, object>;
type P2 = Extract<NonNullable<{ label: string; text?: string }>, object>;
export declare const find: import("@tokamak/sdk/client").ScreenFind<{
  "section": P1;
  "h1": P1;
  "p": P1;
  "FixtureBody": {};
}, {
  "FixtureBody": [[never, P1]];
  "FixtureView": [[never, {}]];
}, { "FixtureBody":P2 }>;
