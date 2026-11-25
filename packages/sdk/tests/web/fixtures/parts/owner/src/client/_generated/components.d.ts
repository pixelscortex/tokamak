// Generated plugin screen paths. Commit this file.
export * from "../api";
type Props1 = Extract<NonNullable<import("../api").ExampleProps>, object>;
type Props2 = Extract<NonNullable<Parameters<typeof import("../api")["Composer"]>[0]>, object>;
type Props3 = Extract<NonNullable<{ children: import("@solidjs/web").JSX.Element }>, object>;
type Props4 = Extract<NonNullable<Parameters<typeof import("../api")["Labels"]>[0]>, object>;
type Props5 = Extract<NonNullable<Props4 & { readonly $row: { readonly item: string; readonly index: () => number } }>, object>;
type Props6 = Extract<NonNullable<Parameters<typeof import("../api")["BenchmarkRow"]>[0]>, object>;
export declare const parts: {
  readonly "SendButton": {
    readonly "button": import("@tokamak/sdk/client").ComponentPart<"owner.SendButton.button", Props1>;
  };
  readonly "Composer": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"owner.Composer.section", Props2> & {
      readonly "SendButton": import("@tokamak/sdk/client").ComponentPart<"owner.Composer.section.SendButton", Props2>;
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"owner.Composer.section.div", Props2>;
    };
  };
  readonly "Region": {
    readonly "main": import("@tokamak/sdk/client").ComponentPart<"owner.Region.main", Props3>;
  };
  readonly "Labels": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"owner.Labels.section", Props4> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"owner.Labels.section.span", Props5>;
      readonly "input": import("@tokamak/sdk/client").ComponentPart<"owner.Labels.section.input", Props4>;
      readonly "Region": import("@tokamak/sdk/client").ComponentPart<"owner.Labels.section.Region", Props4> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"owner.Labels.section.Region.span", Props4>;
      };
      readonly "button": import("@tokamak/sdk/client").ComponentPart<"owner.Labels.section.button", Props4>;
    };
  };
  readonly "BenchmarkRow": {
    readonly "article": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article", Props6> & {
      readonly "header": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article.header", Props6> & {
        readonly "b": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article.header.b", Props6>;
        readonly "time": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article.header.time", Props6>;
      };
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article.div", Props6> & {
        readonly "p": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article.div.p", Props6>;
      };
      readonly "footer": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article.footer", Props6> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article.footer.span", Props6>;
      };
    };
  };
};
