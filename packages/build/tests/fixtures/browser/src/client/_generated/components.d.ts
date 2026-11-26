// Generated plugin screen paths. Commit this file.
export * from "../api";
type Props1 = Extract<NonNullable<Parameters<typeof import("../api")["FixtureBody"]>[0]>, object>;
export declare const parts: {
  readonly "FixtureBody": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"browser-fixture.FixtureBody.section", Props1> & {
      readonly "h1": import("@tokamak/sdk/client").ComponentPart<"browser-fixture.FixtureBody.section.h1", Props1>;
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"browser-fixture.FixtureBody.section.p", Props1>;
    };
  };
  readonly "FixtureView": {
    readonly "FixtureBody": import("@tokamak/sdk/client").ComponentPart<"browser-fixture.FixtureView.FixtureBody", {}>;
  };
};
