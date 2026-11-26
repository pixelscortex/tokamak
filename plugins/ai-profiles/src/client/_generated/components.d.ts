// Generated plugin screen paths. Commit this file.
export * from "../api";
type Props1 = Extract<NonNullable<{} & { readonly $row: { readonly item: import("plugin:agent-proxy/server").SubscriptionView; readonly index: () => number } }>, object>;
type Props2 = Extract<NonNullable<{} & { readonly $row: { readonly item: import("../lib/api").SignIn; readonly index: () => number } }>, object>;
type Props3 = Extract<NonNullable<import("../ui/add-dialog").AddDialogProps>, object>;
type Props4 = Extract<NonNullable<{ step: keyof typeof STEPS; mark?: boolean; children: import("@solidjs/web").JSX.Element }>, object>;
type Props5 = Extract<NonNullable<Props4 & { readonly $row: { readonly item: number; readonly index: () => number } }>, object>;
type Props6 = Extract<NonNullable<{ message: string | undefined }>, object>;
type Props7 = Extract<NonNullable<{ onPick: () => void }>, object>;
type Props8 = Extract<NonNullable<{ start: () => Promise<unknown>; onBack: () => void }>, object>;
type Props9 = Extract<NonNullable<{
  signIn: import("../lib/api").SignIn;
  finish: (pasted: string) => Promise<unknown>;
  restart: () => Promise<unknown>;
  copy?: (text: string) => Promise<void>;
}>, object>;
type Props10 = Extract<NonNullable<{
  subscription: import("../lib/api").Subscription;
  done: (label: string) => Promise<unknown>;
}>, object>;
type Props11 = Extract<NonNullable<Props10 & { readonly $row: { readonly item: { id: string; name: string; }; readonly index: () => number } }>, object>;
type Props12 = Extract<NonNullable<{
  company: import("../lib/api").Company | "openai";
  size: keyof typeof sizes;
  class?: string;
}>, object>;
type Props13 = Extract<NonNullable<Props12 & { readonly $row: { readonly item: { d: string; fillRule?: "evenodd" | "nonzero" | undefined; }; readonly index: () => number } }>, object>;
type Props14 = Extract<NonNullable<{
  subscription: import("../lib/api").Subscription;
  now: number;
  onEnabled: (enabled: boolean) => void;
  onSignIn: () => Promise<unknown>;
}>, object>;
type Props15 = Extract<NonNullable<Props14 & { readonly $row: { readonly item: { email?: string | undefined; organization?: string | undefined; status: "ok" | "signed-out"; }; readonly index: () => number } }>, object>;
type Props16 = Extract<NonNullable<{
  signIn: import("../lib/api").SignIn;
  onContinue: () => void;
  onCancel: () => Promise<unknown>;
  onRestart: () => Promise<unknown>;
}>, object>;
export declare const parts: {
  readonly "Profiles": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div", {}> & {
      readonly "section": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section", {}> & {
        readonly "header": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.header", {}> & {
          readonly "h2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.header.h2", {}> & {
            readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.header.h2.span", {}>;
            readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.header.h2.span$2", {}>;
          };
          readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.header.Button", {}>;
        };
        readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.p", {}>;
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.div", {}> & {
          readonly "SubscriptionCard": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.div.SubscriptionCard", Props1>;
          readonly "AwaitingCard": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.div.AwaitingCard", Props2>;
        };
        readonly "p$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.p$2", {}>;
      };
      readonly "AddDialog": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.AddDialog", {}>;
    };
  };
  readonly "AddDialog": {
    readonly "Dialog$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root", Props3> & {
      readonly "Dialog$2e$Backdrop": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root.Dialog$2e$Backdrop", Props3>;
      readonly "Dialog$2e$Content": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root.Dialog$2e$Content", Props3> & {
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root.Dialog$2e$Content.div", Props3> & {
          readonly "CompanyStep": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root.Dialog$2e$Content.div.CompanyStep", Props3>;
          readonly "MethodStep": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root.Dialog$2e$Content.div.MethodStep", Props3>;
          readonly "SignInStep": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root.Dialog$2e$Content.div.SignInStep", Props3>;
          readonly "ConnectedStep": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root.Dialog$2e$Content.div.ConnectedStep", Props3>;
        };
      };
    };
  };
  readonly "Header": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Header.div", Props4> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Header.div.div", Props4> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Header.div.div.span", Props5>;
      };
      readonly "CompanyMark": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Header.div.CompanyMark", Props4>;
      readonly "Dialog$2e$Title": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Header.div.Dialog$2e$Title", Props4>;
      readonly "Dialog$2e$Close": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Header.div.Dialog$2e$Close", Props4>;
    };
  };
  readonly "Problem": {
    readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Problem.p", Props6>;
  };
  readonly "CompanyStep": {
    readonly "Header": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.Header", Props7>;
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div", Props7> & {
      readonly "Row": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.Row", Props7> & {
        readonly "CompanyMark": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.Row.CompanyMark", Props7>;
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.Row.Icon", Props7>;
      };
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.div", Props7> & {
        readonly "Row": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.div.Row", Props7> & {
          readonly "CompanyMark": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.div.Row.CompanyMark", Props7>;
        };
      };
      readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.div$2", Props7>;
      readonly "div$3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.div$3", Props7> & {
        readonly "Row": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.div$3.Row", Props7> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.div$3.Row.span", Props7>;
        };
      };
    };
  };
  readonly "MethodStep": {
    readonly "Header": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.Header", Props8>;
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div", Props8> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div.div", Props8> & {
        readonly "Row": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div.div.Row", Props8> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div.div.Row.Icon", Props8>;
          readonly "Icon$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div.div.Row.Icon$2", Props8>;
        };
      };
      readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div.div$2", Props8> & {
        readonly "Row": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div.div$2.Row", Props8> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div.div$2.Row.Icon", Props8>;
        };
      };
    };
    readonly "Problem": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.Problem", Props8>;
    readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div$2", Props8> & {
      readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div$2.Button", Props8>;
    };
  };
  readonly "SignInStep": {
    readonly "Header": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.Header", Props9>;
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div", Props9> & {
      readonly "Problem": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div.Problem", Props9>;
      readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div.Button", Props9>;
    };
    readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div$2", Props9> & {
      readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div$2.Button", Props9> & {
        readonly "a": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div$2.Button.a", Props9>;
      };
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div$2.span", Props9>;
      readonly "Button$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div$2.Button$2", Props9>;
    };
    readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.p", Props9> & {
      readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.p.Icon", Props9>;
    };
    readonly "form": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.form", Props9> & {
      readonly "paste$2d$help": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.form.paste$2d$help", Props9>;
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.form.div", Props9> & {
        readonly "Input": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.form.div.Input", Props9>;
        readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.form.div.Button", Props9>;
      };
      readonly "Problem": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.form.Problem", Props9>;
    };
    readonly "Collapsible$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.Collapsible$2e$Root", Props9> & {
      readonly "Collapsible$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.Collapsible$2e$Root.Collapsible$2e$Trigger", Props9>;
      readonly "Collapsible$2e$Panel": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.Collapsible$2e$Root.Collapsible$2e$Panel", Props9> & {
        readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.Collapsible$2e$Root.Collapsible$2e$Panel.p", Props9>;
      };
    };
  };
  readonly "ConnectedStep": {
    readonly "Header": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.Header", Props10>;
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div", Props10> & {
      readonly "CompanyMark": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div.CompanyMark", Props10>;
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div.div", Props10> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div.div.span", Props10>;
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div.div.span$2", Props10>;
      };
      readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div.Icon", Props10>;
    };
    readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div$2", Props10> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div$2.span", Props10>;
      readonly "ul": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div$2.ul", Props10> & {
        readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div$2.ul.li", Props11> & {
          readonly "Chip": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div$2.ul.li.Chip", Props11>;
        };
      };
    };
    readonly "form": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.form", Props10> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.form.div", Props10> & {
        readonly "label": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.form.div.label", Props10>;
        readonly "subscription$2d$label": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.form.div.subscription$2d$label", Props10>;
        readonly "Problem": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.form.div.Problem", Props10>;
      };
      readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.form.div$2", Props10> & {
        readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.form.div$2.Button", Props10>;
      };
    };
  };
  readonly "CompanyMark": {
    readonly "svg": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyMark.svg", Props12> & {
      readonly "path": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyMark.svg.path", Props13>;
    };
  };
  readonly "SubscriptionCard": {
    readonly "article": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article", Props14> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div", Props14> & {
        readonly "CompanyMark": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div.CompanyMark", Props14>;
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div.div", Props14> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div.div.span", Props14>;
          readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div.div.span$2", Props14>;
        };
        readonly "Switch": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div.Switch", Props14>;
      };
      readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$2", Props14> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$2.span", Props15>;
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$2.span$2", Props14>;
      };
      readonly "div$3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$3", Props14> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$3.Icon", Props14>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$3.span", Props14>;
        readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$3.Button", Props14>;
      };
      readonly "div$4": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$4", Props14> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$4.Icon", Props14>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$4.span", Props14>;
      };
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.span", Props14>;
    };
  };
  readonly "AwaitingCard": {
    readonly "article": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article", Props16> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.span", Props16> & {
        readonly "CompanyMark": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.span.CompanyMark", Props16>;
      };
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div", Props16> & {
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div", Props16> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div.span", Props16>;
          readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div.span$2", Props16>;
          readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div.span$3", Props16> & {
            readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div.span$3.Icon", Props16>;
          };
        };
        readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div$2", Props16> & {
          readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div$2.Button", Props16>;
          readonly "Button$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div$2.Button$2", Props16>;
          readonly "Button$3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div$2.Button$3", Props16>;
        };
      };
    };
  };
};
