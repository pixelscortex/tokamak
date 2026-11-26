// Generated plugin screen paths. Commit this file.
export * from "../api";
type Props1 = Extract<NonNullable<import("../api").ExampleProps>, object>;
type Props2 = Extract<NonNullable<Parameters<typeof import("../api")["Composer"]>[0]>, object>;
type Props3 = Extract<NonNullable<{ children: import("@solidjs/web").JSX.Element }>, object>;
type Props4 = Extract<NonNullable<Parameters<typeof import("../api")["Labels"]>[0]>, object>;
type Props5 = Extract<NonNullable<Props4 & { readonly $row: { readonly item: string; readonly index: () => number } }>, object>;
type Props6 = Extract<NonNullable<Props4 & { readonly $row: { readonly item: () => string; readonly index: number; readonly parent: { readonly item: string; readonly index: () => number } } }>, object>;
type Props7 = Extract<NonNullable<Parameters<typeof import("../api")["BenchmarkRow"]>[0]>, object>;
type Props8 = Extract<NonNullable<{ text: string; unloaded?: () => void }>, object>;
type Props9 = Extract<NonNullable<Parameters<typeof import("../api")["RealisticRow"]>[0]>, object>;
export declare const parts: {
  readonly "SendButton": {
    readonly "button": import("@tokamak/sdk/client").ComponentPart<"owner.SendButton.button", Props1>;
  };
  readonly "Composer": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"owner.Composer.section", Props2> & {
      readonly "SendButton": import("@tokamak/sdk/client").ComponentPart<"owner.Composer.section.SendButton", Props2>;
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"owner.Composer.section.div", Props2>;
      readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"owner.Composer.section.div$2", Props2>;
    };
  };
  readonly "Region": {
    readonly "main": import("@tokamak/sdk/client").ComponentPart<"owner.Region.main", Props3>;
  };
  readonly "Labels": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"owner.Labels.section", Props4> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"owner.Labels.section.span", Props5>;
      readonly "groups": import("@tokamak/sdk/client").ComponentPart<"owner.Labels.section.groups", Props4> & {
        readonly "em": import("@tokamak/sdk/client").ComponentPart<"owner.Labels.section.groups.em", Props6>;
      };
      readonly "input": import("@tokamak/sdk/client").ComponentPart<"owner.Labels.section.input", Props4>;
      readonly "Region": import("@tokamak/sdk/client").ComponentPart<"owner.Labels.section.Region", Props4> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"owner.Labels.section.Region.span", Props4>;
      };
      readonly "button": import("@tokamak/sdk/client").ComponentPart<"owner.Labels.section.button", Props4>;
    };
  };
  readonly "BenchmarkRow": {
    readonly "article": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article", Props7> & {
      readonly "header": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article.header", Props7> & {
        readonly "b": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article.header.b", Props7>;
        readonly "time": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article.header.time", Props7>;
      };
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article.div", Props7> & {
        readonly "p": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article.div.p", Props7>;
      };
      readonly "footer": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article.footer", Props7> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"owner.BenchmarkRow.article.footer.span", Props7>;
      };
    };
  };
  readonly "RowStatus": {
    readonly "small": import("@tokamak/sdk/client").ComponentPart<"owner.RowStatus.small", Props8>;
  };
  readonly "RealisticRow": {
    readonly "article": import("@tokamak/sdk/client").ComponentPart<"owner.RealisticRow.article", Props9> & {
      readonly "header": import("@tokamak/sdk/client").ComponentPart<"owner.RealisticRow.article.header", Props9> & {
        readonly "b": import("@tokamak/sdk/client").ComponentPart<"owner.RealisticRow.article.header.b", Props9>;
        readonly "time": import("@tokamak/sdk/client").ComponentPart<"owner.RealisticRow.article.header.time", Props9>;
        readonly "RowStatus": import("@tokamak/sdk/client").ComponentPart<"owner.RealisticRow.article.header.RowStatus", Props9>;
      };
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"owner.RealisticRow.article.div", Props9> & {
        readonly "p": import("@tokamak/sdk/client").ComponentPart<"owner.RealisticRow.article.div.p", Props9>;
        readonly "button": import("@tokamak/sdk/client").ComponentPart<"owner.RealisticRow.article.div.button", Props9> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"owner.RealisticRow.article.div.button.span", Props9>;
        };
      };
      readonly "footer": import("@tokamak/sdk/client").ComponentPart<"owner.RealisticRow.article.footer", Props9> & {
        readonly "a": import("@tokamak/sdk/client").ComponentPart<"owner.RealisticRow.article.footer.a", Props9> & {
          readonly "svg": import("@tokamak/sdk/client").ComponentPart<"owner.RealisticRow.article.footer.a.svg", Props9> & {
            readonly "path": import("@tokamak/sdk/client").ComponentPart<"owner.RealisticRow.article.footer.a.svg.path", Props9>;
          };
        };
      };
    };
  };
};
