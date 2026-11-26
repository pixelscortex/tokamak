// Generated plugin screen paths. Commit this file.
export * from "../api";
type Local1 = { subscriptions: readonly import("../lib/api").Subscription[]; signIns: readonly import("../lib/api").SignIn[] };
type Local2 = import("../lib/api").Subscription["accounts"][number];
type Local3 = { label: () => string; icon: string; tip: () => string; run: () => unknown };
type Local4 = { failed: true; kind: string; data: { message: string; field?: string } };
type Local5 = { threadId: string | undefined };
type Props1 = Extract<NonNullable<{} & { readonly $row: { readonly item: () => import("plugin:agent-proxy/server").SubscriptionView; readonly index: () => number } }>, object>;
type Props2 = Extract<NonNullable<{} & { readonly $row: { readonly item: () => import("plugin:agent-proxy/server").SignInView; readonly index: () => number } }>, object>;
type Props3 = Extract<NonNullable<{ data: Local1 | undefined; returns: import("../pages/subscription").Returns }>, object>;
type Props4 = Extract<NonNullable<{ title: string; count?: number; children?: import("@solidjs/web").JSX.Element }>, object>;
type Props5 = Extract<NonNullable<{
  subscription: import("../lib/api").Subscription;
  data: () => Local1 | undefined;
  returns: import("../pages/subscription").Returns;
}>, object>;
type Props6 = Extract<NonNullable<Props5 & { readonly $row: { readonly item: () => { id: string; email?: string | undefined; organization?: string | undefined; status: "ok" | "signed-out"; reason?: string | undefined; }; readonly index: () => number } }>, object>;
type Props7 = Extract<NonNullable<{
  account: Local2;
  onSignOut: () => Promise<unknown>;
  onSignIn: () => Promise<unknown>;
}>, object>;
type Props8 = Extract<NonNullable<{ subscription: import("../lib/api").Subscription }>, object>;
type Props9 = Extract<NonNullable<{ title: string }>, object>;
type Props10 = Extract<NonNullable<Props8 & { readonly $row: { readonly item: () => { id: string; name: string; }; readonly index: () => number } }>, object>;
type Props11 = Extract<NonNullable<Props8 & { readonly $row: { readonly item: () => import("../../server/profile-uses").ProfileUse; readonly index: () => number } }>, object>;
type Props12 = Extract<NonNullable<import("../ui/add-dialog").AddDialogProps>, object>;
type Props13 = Extract<NonNullable<{ step: keyof typeof STEPS; mark?: import("../lib/api").Company; children: import("@solidjs/web").JSX.Element }>, object>;
type Props14 = Extract<NonNullable<Props13 & { readonly $row: { readonly item: number; readonly index: () => number } }>, object>;
type Props15 = Extract<NonNullable<{ message: string | undefined }>, object>;
type Props16 = Extract<NonNullable<{ onPick: (company: import("../lib/api").Company) => void }>, object>;
type Props17 = Extract<NonNullable<Props16 & { readonly $row: { readonly item: "anthropic" | "openai"; readonly index: () => number } }>, object>;
type Props18 = Extract<NonNullable<{
  company: import("../lib/api").Company;
  start: () => Promise<unknown>;
  onBack: () => void;
}>, object>;
type Props19 = Extract<NonNullable<{
  signIn: import("../lib/api").SignIn;
  listening: boolean;
  returned: { address: string; problem?: string } | undefined;
  finish: (pasted: string) => Promise<unknown>;
  restart: () => Promise<unknown>;
  copy?: (text: string) => Promise<void>;
}>, object>;
type Props20 = Extract<NonNullable<{
  subscription: import("../lib/api").Subscription;
  done: (label: string) => Promise<unknown>;
}>, object>;
type Props21 = Extract<NonNullable<Props20 & { readonly $row: { readonly item: { id: string; name: string; }; readonly index: () => number } }>, object>;
type Props22 = Extract<NonNullable<Local3>, object>;
type Props23 = Extract<NonNullable<{
  subscription: import("../lib/api").Subscription;
  /** "Add to profile" (TKM-264), before Remove. */
  addToProfile?: import("@solidjs/web").JSX.Element;
}>, object>;
type Props24 = Extract<NonNullable<{ subscription: import("../lib/api").Subscription; builder: import("../lib/builder").Builder }>, object>;
type Props25 = Extract<NonNullable<Props24 & { readonly $row: { readonly item: string; readonly index: () => number } }>, object>;
type Props26 = Extract<NonNullable<Props24 & { readonly $row: { readonly item: () => import("../../server/profiles").ProfileView; readonly index: () => number } }>, object>;
type Props27 = Extract<NonNullable<{
  company: import("../lib/api").Company;
  size: keyof typeof sizes;
  class?: string;
}>, object>;
type Props28 = Extract<NonNullable<Props27 & { readonly $row: { readonly item: { d: string; fillRule?: "evenodd" | "nonzero" | undefined; }; readonly index: () => number } }>, object>;
type Props29 = Extract<NonNullable<{
  profile: import("../lib/builder").Profile;
  builder: import("../lib/builder").Builder;
  subscriptions: ReadonlyMap<string, import("../lib/api").Subscription>;
}>, object>;
type Props30 = Extract<NonNullable<Props29 & { readonly $row: { readonly item: string; readonly index: () => number } }>, object>;
type Props31 = Extract<NonNullable<{ position: number }>, object>;
type Props32 = Extract<NonNullable<{
  profile: import("../lib/builder").Profile;
  builder: import("../lib/builder").Builder;
  subscription: import("../lib/api").Subscription | undefined;
  id: string;
  position: number;
  count: number;
}>, object>;
type Props33 = Extract<NonNullable<{
  open: boolean;
  onClose: () => void;
  create: (name: string, code: string) => Promise<import("../lib/builder").Profile | Local4>;
}>, object>;
type Props34 = Extract<NonNullable<{
  builder: import("../lib/builder").Builder;
  subscriptions: readonly import("../lib/api").Subscription[];
}>, object>;
type Props35 = Extract<NonNullable<Props34 & { readonly $row: { readonly item: () => import("../../server/profiles").ProfileView; readonly index: () => number } }>, object>;
type Props36 = Extract<NonNullable<{ subscriptions: readonly import("../lib/api").Subscription[] }>, object>;
type Props37 = Extract<NonNullable<{
  subscription: import("../lib/api").Subscription;
  now: number;
  onEnabled: (enabled: boolean) => void;
  onSignIn: () => Promise<unknown>;
  /** The row of icon buttons under the card's lines. */
  actions?: import("@solidjs/web").JSX.Element;
  /** Faded: a pointed-at profile does not hold it, or it is the card being dragged. */
  dimmed?: boolean;
  /** The end of the model line: the codes of the profiles that use it. */
  profiles?: import("@solidjs/web").JSX.Element;
  /** Starts dragging the card into a profile. */
  onPointerDown?: (event: PointerEvent) => void;
}>, object>;
type Props38 = Extract<NonNullable<Props37 & { readonly $row: { readonly item: () => { id: string; email?: string | undefined; organization?: string | undefined; status: "ok" | "signed-out"; reason?: string | undefined; }; readonly index: () => number } }>, object>;
type Props39 = Extract<NonNullable<{
  signIn: import("../lib/api").SignIn;
  onContinue: () => void;
  onCancel: () => Promise<unknown>;
  onRestart: () => Promise<unknown>;
  /** Faded while a profile is pointed at: a sign-in is in no profile. */
  dimmed?: boolean;
}>, object>;
type Props40 = Extract<NonNullable<{ code?: string }>, object>;
type Props41 = Extract<NonNullable<Local5 & {
    refreshCatalog: () => void;
    resetCatalog: () => void;
  }>, object>;
type Props42 = Extract<NonNullable<Local5>, object>;
type Props43 = Extract<NonNullable<Props42 & { readonly $row: { readonly item: () => import("../../server/profiles").ProfileView; readonly index: () => number } }>, object>;
type Props44 = Extract<NonNullable<import("plugin:chat/client").ThreadRowProps>, object>;
export declare const parts: {
  readonly "Profiles": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div", {}> & {
      readonly "SubscriptionDetails": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.SubscriptionDetails", {}>;
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
          readonly "SubscriptionCard": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.div.SubscriptionCard", Props1> & {
            readonly "CardActions": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.div.SubscriptionCard.CardActions", Props1> & {
              readonly "AddToProfile": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.div.SubscriptionCard.CardActions.AddToProfile", Props1>;
            };
            readonly "CardProfiles": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.div.SubscriptionCard.CardProfiles", Props1>;
          };
          readonly "AwaitingCard": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.div.AwaitingCard", Props2>;
        };
        readonly "p$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.section.p$2", {}>;
      };
      readonly "ProfilesSection": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.ProfilesSection", {}>;
      readonly "RemoveDialog": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.RemoveDialog", {}>;
      readonly "AddDialog": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Profiles.div.AddDialog", {}>;
    };
  };
  readonly "SubscriptionDetails": {
    readonly "Details": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionDetails.Details", Props3>;
  };
  readonly "SectionHeader": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SectionHeader.div", Props4> & {
      readonly "h3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SectionHeader.div.h3", Props4> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SectionHeader.div.h3.span", Props4>;
      };
    };
  };
  readonly "Details": {
    readonly "Breadcrumb": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.Breadcrumb", Props5>;
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section", Props5> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section.div", Props5> & {
        readonly "CompanyMark": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section.div.CompanyMark", Props5>;
        readonly "h2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section.div.h2", Props5>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section.div.span", Props5>;
      };
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section.p", Props5>;
      readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section.div$2", Props5> & {
        readonly "section": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section.div$2.section", Props5> & {
          readonly "SectionHeader": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section.div$2.section.SectionHeader", Props5> & {
            readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section.div$2.section.SectionHeader.Button", Props5>;
          };
          readonly "ul": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section.div$2.section.ul", Props5> & {
            readonly "AccountRow": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section.div$2.section.ul.AccountRow", Props6>;
          };
        };
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section.div$2.div", Props5> & {
          readonly "Label": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section.div$2.div.Label", Props5>;
          readonly "Models": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section.div$2.div.Models", Props5>;
          readonly "UsedBy": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.section.div$2.div.UsedBy", Props5>;
        };
      };
    };
    readonly "AddDialog": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Details.AddDialog", Props5>;
  };
  readonly "AccountRow": {
    readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AccountRow.li", Props7> & {
      readonly "Avatar": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AccountRow.li.Avatar", Props7>;
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AccountRow.li.div", Props7> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AccountRow.li.div.span", Props7>;
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AccountRow.li.div.span$2", Props7>;
        readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AccountRow.li.div.span$3", Props7> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AccountRow.li.div.span$3.span", Props7>;
        };
      };
      readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AccountRow.li.Button", Props7>;
      readonly "Button$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AccountRow.li.Button$2", Props7>;
    };
  };
  readonly "Label": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Label.section", Props8> & {
      readonly "SectionHeader": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Label.section.SectionHeader", Props8>;
      readonly "form": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Label.section.form", Props8> & {
        readonly "Input": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Label.section.form.Input", Props8>;
        readonly "label$2d$problem": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Label.section.form.label$2d$problem", Props8>;
      };
    };
  };
  readonly "Breadcrumb": {
    readonly "Region$2e$Header": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Breadcrumb.Region$2e$Header", Props9> & {
      readonly "nav": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Breadcrumb.Region$2e$Header.nav", Props9> & {
        readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Breadcrumb.Region$2e$Header.nav.Button", Props9>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Breadcrumb.Region$2e$Header.nav.span", Props9>;
        readonly "h1": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Breadcrumb.Region$2e$Header.nav.h1", Props9>;
      };
    };
  };
  readonly "Models": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Models.section", Props8> & {
      readonly "SectionHeader": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Models.section.SectionHeader", Props8> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Models.section.SectionHeader.span", Props8>;
      };
      readonly "ul": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Models.section.ul", Props8> & {
        readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Models.section.ul.li", Props10> & {
          readonly "Chip": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Models.section.ul.li.Chip", Props10>;
        };
      };
    };
  };
  readonly "UsedBy": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.UsedBy.section", Props8> & {
      readonly "SectionHeader": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.UsedBy.section.SectionHeader", Props8>;
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.UsedBy.section.p", Props8>;
      readonly "ul": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.UsedBy.section.ul", Props8> & {
        readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.UsedBy.section.ul.li", Props11> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.UsedBy.section.ul.li.span", Props11> & {
            readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.UsedBy.section.ul.li.span.Icon", Props11>;
            readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.UsedBy.section.ul.li.span.span", Props11>;
          };
          readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.UsedBy.section.ul.li.span$2", Props11>;
          readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.UsedBy.section.ul.li.span$3", Props11>;
        };
      };
    };
  };
  readonly "AddDialog": {
    readonly "Dialog$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root", Props12> & {
      readonly "Dialog$2e$Backdrop": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root.Dialog$2e$Backdrop", Props12>;
      readonly "Dialog$2e$Content": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root.Dialog$2e$Content", Props12> & {
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root.Dialog$2e$Content.div", Props12> & {
          readonly "CompanyStep": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root.Dialog$2e$Content.div.CompanyStep", Props12>;
          readonly "MethodStep": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root.Dialog$2e$Content.div.MethodStep", Props12>;
          readonly "SignInStep": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root.Dialog$2e$Content.div.SignInStep", Props12>;
          readonly "ConnectedStep": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddDialog.Dialog$2e$Root.Dialog$2e$Content.div.ConnectedStep", Props12>;
        };
      };
    };
  };
  readonly "Header": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Header.div", Props13> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Header.div.div", Props13> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Header.div.div.span", Props14>;
      };
      readonly "CompanyMark": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Header.div.CompanyMark", Props13>;
      readonly "Dialog$2e$Title": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Header.div.Dialog$2e$Title", Props13>;
      readonly "Dialog$2e$Close": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Header.div.Dialog$2e$Close", Props13>;
    };
  };
  readonly "Problem": {
    readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Problem.p", Props15>;
  };
  readonly "CompanyStep": {
    readonly "Header": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.Header", Props16>;
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div", Props16> & {
      readonly "Row": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.Row", Props17> & {
        readonly "CompanyMark": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.Row.CompanyMark", Props17>;
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.Row.Icon", Props17>;
      };
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.div", Props16>;
      readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.div$2", Props16> & {
        readonly "Row": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.div$2.Row", Props16> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyStep.div.div$2.Row.span", Props16>;
        };
      };
    };
  };
  readonly "MethodStep": {
    readonly "Header": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.Header", Props18>;
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div", Props18> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div.div", Props18> & {
        readonly "Row": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div.div.Row", Props18> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div.div.Row.Icon", Props18>;
          readonly "Icon$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div.div.Row.Icon$2", Props18>;
        };
      };
      readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div.div$2", Props18> & {
        readonly "Row": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div.div$2.Row", Props18> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div.div$2.Row.Icon", Props18>;
        };
      };
    };
    readonly "Problem": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.Problem", Props18>;
    readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div$2", Props18> & {
      readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.MethodStep.div$2.Button", Props18>;
    };
  };
  readonly "SignInStep": {
    readonly "Header": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.Header", Props19>;
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div", Props19> & {
      readonly "Problem": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div.Problem", Props19>;
      readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div.Button", Props19>;
    };
    readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div$2", Props19> & {
      readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div$2.Button", Props19> & {
        readonly "a": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div$2.Button.a", Props19>;
      };
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div$2.span", Props19>;
      readonly "Button$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.div$2.Button$2", Props19>;
    };
    readonly "sign$2d$in$2d$help": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.sign$2d$in$2d$help", Props19> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.sign$2d$in$2d$help.span", Props19> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.sign$2d$in$2d$help.span.Icon", Props19>;
      };
    };
    readonly "form": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.form", Props19> & {
      readonly "paste$2d$help": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.form.paste$2d$help", Props19>;
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.form.div", Props19> & {
        readonly "Input": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.form.div.Input", Props19>;
        readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.form.div.Button", Props19>;
      };
      readonly "Problem": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SignInStep.form.Problem", Props19>;
    };
  };
  readonly "ConnectedStep": {
    readonly "Header": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.Header", Props20>;
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div", Props20> & {
      readonly "CompanyMark": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div.CompanyMark", Props20>;
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div.div", Props20> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div.div.span", Props20>;
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div.div.span$2", Props20>;
      };
      readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div.Icon", Props20>;
    };
    readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div$2", Props20> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div$2.span", Props20>;
      readonly "ul": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div$2.ul", Props20> & {
        readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div$2.ul.li", Props21> & {
          readonly "Chip": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.div$2.ul.li.Chip", Props21>;
        };
      };
    };
    readonly "form": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.form", Props20> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.form.div", Props20> & {
        readonly "label": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.form.div.label", Props20>;
        readonly "subscription$2d$label": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.form.div.subscription$2d$label", Props20>;
        readonly "Problem": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.form.div.Problem", Props20>;
      };
      readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.form.div$2", Props20> & {
        readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ConnectedStep.form.div$2.Button", Props20>;
      };
    };
  };
  readonly "CardActions": {
    readonly "button": {
      readonly "Tooltip$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CardActions.button.Tooltip$2e$Root", Props22> & {
        readonly "Tooltip$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CardActions.button.Tooltip$2e$Root.Tooltip$2e$Trigger", Props22>;
        readonly "Tooltip$2e$Content": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CardActions.button.Tooltip$2e$Root.Tooltip$2e$Content", Props22>;
      };
    };
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CardActions.div", Props23> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CardActions.div.div", Props23> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CardActions.div.div.span", Props23>;
      };
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CardActions.div.p", Props23>;
    };
  };
  readonly "CardProfiles": {
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CardProfiles.span", Props24> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CardProfiles.span.span", Props25> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CardProfiles.span.span.Icon", Props25>;
      };
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CardProfiles.span.span$2", Props24>;
    };
  };
  readonly "AddToProfile": {
    readonly "Menu$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddToProfile.Menu$2e$Root", Props24> & {
      readonly "Tooltip$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddToProfile.Menu$2e$Root.Tooltip$2e$Root", Props24> & {
        readonly "Tooltip$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddToProfile.Menu$2e$Root.Tooltip$2e$Root.Tooltip$2e$Trigger", Props24> & {
          readonly "Menu$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddToProfile.Menu$2e$Root.Tooltip$2e$Root.Tooltip$2e$Trigger.Menu$2e$Trigger", Props24>;
        };
        readonly "Tooltip$2e$Content": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddToProfile.Menu$2e$Root.Tooltip$2e$Root.Tooltip$2e$Content", Props24>;
      };
      readonly "Menu$2e$Content": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddToProfile.Menu$2e$Root.Menu$2e$Content", Props24> & {
        readonly "Menu$2e$Group": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddToProfile.Menu$2e$Root.Menu$2e$Content.Menu$2e$Group", Props24> & {
          readonly "Menu$2e$GroupLabel": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddToProfile.Menu$2e$Root.Menu$2e$Content.Menu$2e$Group.Menu$2e$GroupLabel", Props24>;
          readonly "Menu$2e$Item": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddToProfile.Menu$2e$Root.Menu$2e$Content.Menu$2e$Group.Menu$2e$Item", Props26> & {
            readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddToProfile.Menu$2e$Root.Menu$2e$Content.Menu$2e$Group.Menu$2e$Item.span", Props26>;
            readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddToProfile.Menu$2e$Root.Menu$2e$Content.Menu$2e$Group.Menu$2e$Item.span$2", Props26>;
            readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddToProfile.Menu$2e$Root.Menu$2e$Content.Menu$2e$Group.Menu$2e$Item.span$3", Props26>;
          };
          readonly "Menu$2e$Item$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AddToProfile.Menu$2e$Root.Menu$2e$Content.Menu$2e$Group.Menu$2e$Item$2", Props24>;
        };
      };
    };
  };
  readonly "CompanyMark": {
    readonly "svg": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyMark.svg", Props27> & {
      readonly "path": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.CompanyMark.svg.path", Props28>;
    };
  };
  readonly "ProfileBox": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileBox.section", Props29> & {
      readonly "header": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileBox.section.header", Props29> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileBox.section.header.Icon", Props29>;
        readonly "h3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileBox.section.header.h3", Props29> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileBox.section.header.h3.span", Props29>;
          readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileBox.section.header.h3.span$2", Props29>;
        };
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileBox.section.header.span", Props29>;
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileBox.section.header.span$2", Props29> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileBox.section.header.span$2.Icon", Props29>;
        };
      };
      readonly "ol": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileBox.section.ol", Props29> & {
        readonly "DropSlot": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileBox.section.ol.DropSlot", Props30>;
        readonly "Entry": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileBox.section.ol.Entry", Props30>;
        readonly "DropSlot$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileBox.section.ol.DropSlot$2", Props29>;
      };
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileBox.section.p", Props29>;
    };
  };
  readonly "DropSlot": {
    readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.DropSlot.li", Props31>;
  };
  readonly "Entry": {
    readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Entry.li", Props32> & {
      readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Entry.li.Icon", Props32>;
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Entry.li.span", Props32>;
      readonly "CompanyMark": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Entry.li.CompanyMark", Props32>;
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Entry.li.span$2", Props32>;
      readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Entry.li.span$3", Props32>;
      readonly "span$4": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Entry.li.span$4", Props32> & {
        readonly "Menu$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Entry.li.span$4.Menu$2e$Root", Props32> & {
          readonly "Menu$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Entry.li.span$4.Menu$2e$Root.Menu$2e$Trigger", Props32>;
          readonly "Menu$2e$Content": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Entry.li.span$4.Menu$2e$Root.Menu$2e$Content", Props32> & {
            readonly "Menu$2e$Item": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Entry.li.span$4.Menu$2e$Root.Menu$2e$Content.Menu$2e$Item", Props32>;
            readonly "Menu$2e$Item$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Entry.li.span$4.Menu$2e$Root.Menu$2e$Content.Menu$2e$Item$2", Props32>;
            readonly "Menu$2e$Separator": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Entry.li.span$4.Menu$2e$Root.Menu$2e$Content.Menu$2e$Separator", Props32>;
            readonly "Menu$2e$Item$3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Entry.li.span$4.Menu$2e$Root.Menu$2e$Content.Menu$2e$Item$3", Props32>;
          };
        };
      };
    };
  };
  readonly "ProfileDialog": {
    readonly "Dialog$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root", Props33> & {
      readonly "Dialog$2e$Backdrop": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Backdrop", Props33>;
      readonly "Dialog$2e$Content": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content", Props33> & {
        readonly "form": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content.form", Props33> & {
          readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content.form.div", Props33> & {
            readonly "Dialog$2e$Title": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content.form.div.Dialog$2e$Title", Props33>;
            readonly "Dialog$2e$Close": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content.form.div.Dialog$2e$Close", Props33>;
          };
          readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content.form.div$2", Props33> & {
            readonly "label": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content.form.div$2.label", Props33>;
            readonly "profile$2d$name": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content.form.div$2.profile$2d$name", Props33>;
          };
          readonly "div$3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content.form.div$3", Props33> & {
            readonly "label": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content.form.div$3.label", Props33>;
            readonly "profile$2d$code": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content.form.div$3.profile$2d$code", Props33>;
            readonly "profile$2d$code$2d$help": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content.form.div$3.profile$2d$code$2d$help", Props33>;
          };
          readonly "profile$2d$problem": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content.form.profile$2d$problem", Props33>;
          readonly "div$4": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content.form.div$4", Props33> & {
            readonly "Dialog$2e$Close": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content.form.div$4.Dialog$2e$Close", Props33>;
            readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileDialog.Dialog$2e$Root.Dialog$2e$Content.form.div$4.Button", Props33>;
          };
        };
      };
    };
  };
  readonly "ProfilesSection": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfilesSection.section", Props34> & {
      readonly "header": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfilesSection.section.header", Props34> & {
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfilesSection.section.header.div", Props34> & {
          readonly "h2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfilesSection.section.header.div.h2", Props34> & {
            readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfilesSection.section.header.div.h2.span", Props34>;
            readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfilesSection.section.header.div.h2.span$2", Props34>;
          };
          readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfilesSection.section.header.div.p", Props34>;
        };
        readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfilesSection.section.header.Button", Props34>;
      };
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfilesSection.section.p", Props34>;
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfilesSection.section.div", Props34> & {
        readonly "ProfileBox": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfilesSection.section.div.ProfileBox", Props35>;
      };
      readonly "p$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfilesSection.section.p$2", Props34>;
      readonly "p$3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfilesSection.section.p$3", Props34>;
      readonly "Ghost": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfilesSection.section.Ghost", Props34>;
      readonly "ProfileDialog": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfilesSection.section.ProfileDialog", Props34>;
    };
  };
  readonly "Ghost": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Ghost.div", Props24> & {
      readonly "CompanyMark": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Ghost.div.CompanyMark", Props24>;
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Ghost.div.span", Props24> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Ghost.div.span.span", Props24>;
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Ghost.div.span.span$2", Props24>;
      };
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Ghost.div.span$2", Props24>;
    };
  };
  readonly "RemoveDialog": {
    readonly "Dialog$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.RemoveDialog.Dialog$2e$Root", Props36> & {
      readonly "Dialog$2e$Backdrop": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.RemoveDialog.Dialog$2e$Root.Dialog$2e$Backdrop", Props36>;
      readonly "Dialog$2e$Content": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.RemoveDialog.Dialog$2e$Root.Dialog$2e$Content", Props36> & {
        readonly "Confirm": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.RemoveDialog.Dialog$2e$Root.Dialog$2e$Content.Confirm", Props36>;
      };
    };
  };
  readonly "Confirm": {
    readonly "Dialog$2e$Title": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Confirm.Dialog$2e$Title", Props8>;
    readonly "Dialog$2e$Description": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Confirm.Dialog$2e$Description", Props8>;
    readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Confirm.p", Props8>;
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Confirm.div", Props8> & {
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Confirm.div.p", Props8>;
      readonly "ul": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Confirm.div.ul", Props8> & {
        readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Confirm.div.ul.li", Props11> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Confirm.div.ul.li.Icon", Props11>;
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Confirm.div.ul.li.span", Props11>;
          readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Confirm.div.ul.li.span$2", Props11>;
        };
      };
    };
    readonly "p$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Confirm.p$2", Props8>;
    readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Confirm.div$2", Props8> & {
      readonly "Dialog$2e$Close": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Confirm.div$2.Dialog$2e$Close", Props8>;
      readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.Confirm.div$2.Button", Props8>;
    };
  };
  readonly "SubscriptionCard": {
    readonly "article": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article", Props37> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div", Props37> & {
        readonly "CompanyMark": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div.CompanyMark", Props37>;
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div.div", Props37> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div.div.span", Props37>;
          readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div.div.span$2", Props37>;
        };
        readonly "Switch": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div.Switch", Props37>;
      };
      readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$2", Props37> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$2.span", Props38>;
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$2.span$2", Props37>;
      };
      readonly "div$3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$3", Props37> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$3.Icon", Props37>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$3.span", Props37>;
        readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$3.Button", Props37>;
      };
      readonly "div$4": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$4", Props37> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$4.Icon", Props37>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$4.span", Props37>;
      };
      readonly "div$5": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$5", Props37> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.SubscriptionCard.article.div$5.span", Props37>;
      };
    };
  };
  readonly "AwaitingCard": {
    readonly "article": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article", Props39> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.span", Props39> & {
        readonly "CompanyMark": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.span.CompanyMark", Props39>;
      };
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div", Props39> & {
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div", Props39> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div.span", Props39>;
          readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div.span$2", Props39>;
          readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div.span$3", Props39> & {
            readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div.span$3.Icon", Props39>;
          };
        };
        readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div$2", Props39> & {
          readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div$2.Button", Props39>;
          readonly "Button$2": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div$2.Button$2", Props39>;
          readonly "Button$3": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.AwaitingCard.article.div.div$2.Button$3", Props39>;
        };
      };
    };
  };
  readonly "ProfileCode": {
    readonly "Chip": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ProfileCode.Chip", Props40>;
  };
  readonly "PickerProfileChip": {
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.PickerProfileChip.span", Props41> & {
      readonly "ProfileCode": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.PickerProfileChip.span.ProfileCode", Props41>;
    };
  };
  readonly "PickerProfileStatus": {
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.PickerProfileStatus.span", Props42>;
  };
  readonly "PickerProfileColumn": {
    readonly "Menu$2e$RadioGroup": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.PickerProfileColumn.Menu$2e$RadioGroup", Props42> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.PickerProfileColumn.Menu$2e$RadioGroup.div", Props42>;
      readonly "Menu$2e$RadioItem": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.PickerProfileColumn.Menu$2e$RadioGroup.Menu$2e$RadioItem", Props43> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.PickerProfileColumn.Menu$2e$RadioGroup.Menu$2e$RadioItem.Icon", Props43>;
        readonly "CompanyMark": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.PickerProfileColumn.Menu$2e$RadioGroup.Menu$2e$RadioItem.CompanyMark", Props43>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.PickerProfileColumn.Menu$2e$RadioGroup.Menu$2e$RadioItem.span", Props43>;
      };
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.PickerProfileColumn.Menu$2e$RadioGroup.span", Props42>;
    };
  };
  readonly "ThreadProfile": {
    readonly "ProfileCode": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.ThreadProfile.ProfileCode", Props44>;
  };
  readonly "IdleThreadProfile": {
    readonly "SavedAgentDetail": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.IdleThreadProfile.SavedAgentDetail", Props44>;
    readonly "ProfileCode": import("@tokamak/sdk/client").ComponentPart<"ai-profiles.IdleThreadProfile.ProfileCode", Props44>;
  };
};
