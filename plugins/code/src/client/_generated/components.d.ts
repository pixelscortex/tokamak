// Generated plugin screen paths. Commit this file.
export * from "../api";
type Local1 = NonNullable<import("@tokamak/sdk").ResultOf<typeof import("../../server/_generated/api").api.changes.diff>>;
type Local2 = Local1["files"][number];
type Local3 = | { readonly kind: "hunk"; readonly text: string }
  | {
      readonly kind: "context" | "added" | "removed" | "note";
      readonly old?: number;
      readonly new?: number;
      readonly text: string;
    };
type Props1 = Extract<NonNullable<import("plugin:chat/client").MessageProps>, object>;
type Props2 = Extract<NonNullable<{ change: import("../lib/changes").ReplyChange }>, object>;
type Props3 = Extract<NonNullable<{ added: number; removed: number }>, object>;
type Props4 = Extract<NonNullable<{ threadId: import("@tokamak/sdk").Id<"threads">; turnId: string | undefined }>, object>;
type Props5 = Extract<NonNullable<{ children: import("@solidjs/web").JSX.Element }>, object>;
type Props6 = Extract<NonNullable<{ number: number; diff: Local1 }>, object>;
type Props7 = Extract<NonNullable<{ file: Local2 }>, object>;
type Props8 = Extract<NonNullable<{ row: Local3 }>, object>;
type Props9 = Extract<NonNullable<import("plugin:chat/client").HeaderProps>, object>;
export declare const parts: {
  readonly "SnapshotNotice": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"code.SnapshotNotice.Show", Props1> & {
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"code.SnapshotNotice.Show.p", Props1>;
    };
    readonly "Show$2": import("@tokamak/sdk/client").ComponentPart<"code.SnapshotNotice.Show$2", Props1> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"code.SnapshotNotice.Show$2.div", Props1> & {
        readonly "p": import("@tokamak/sdk/client").ComponentPart<"code.SnapshotNotice.Show$2.div.p", Props1>;
        readonly "ul": import("@tokamak/sdk/client").ComponentPart<"code.SnapshotNotice.Show$2.div.ul", Props1> & {
          readonly "For": import("@tokamak/sdk/client").ComponentPart<"code.SnapshotNotice.Show$2.div.ul.For", Props1> & {
            readonly "li": import("@tokamak/sdk/client").ComponentPart<"code.SnapshotNotice.Show$2.div.ul.For.li", Props1>;
          };
        };
      };
    };
  };
  readonly "ChangeCard": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.Show", Props1> & {
      readonly "Show": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.Show.Show", Props1> & {
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.Show.Show.div", Props1> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.Show.Show.div.Icon", Props1>;
          readonly "CardText": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.Show.Show.div.CardText", Props1>;
        };
        readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.Show.Show.div$2", Props1> & {
          readonly "Row": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.Show.Show.div$2.Row", Props1> & {
            readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.Show.Show.div$2.Row.Icon", Props1>;
            readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.Show.Show.div$2.Row.span", Props1>;
            readonly "Icon$2": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.Show.Show.div$2.Row.Icon$2", Props1>;
            readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.Show.Show.div$2.Row.span$2", Props1> & {
              readonly "CardText": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.Show.Show.div$2.Row.span$2.CardText", Props1>;
            };
          };
        };
      };
    };
  };
  readonly "CardText": {
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.CardText.span", Props2>;
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"code.CardText.Show", Props2> & {
      readonly "Show": import("@tokamak/sdk/client").ComponentPart<"code.CardText.Show.Show", Props2> & {
        readonly "Show": import("@tokamak/sdk/client").ComponentPart<"code.CardText.Show.Show.Show", Props2> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.CardText.Show.Show.Show.span", Props2>;
        };
        readonly "Counts": import("@tokamak/sdk/client").ComponentPart<"code.CardText.Show.Show.Counts", Props2>;
      };
    };
  };
  readonly "Counts": {
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.Counts.span", Props3>;
    readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"code.Counts.span$2", Props3>;
  };
  readonly "view": {
    readonly "Note": import("@tokamak/sdk/client").ComponentPart<"code.view.Note", {}>;
    readonly "Note$2": import("@tokamak/sdk/client").ComponentPart<"code.view.Note$2", {}>;
    readonly "Note$3": import("@tokamak/sdk/client").ComponentPart<"code.view.Note$3", {}>;
    readonly "Note$4": import("@tokamak/sdk/client").ComponentPart<"code.view.Note$4", {}>;
    readonly "TurnReview": import("@tokamak/sdk/client").ComponentPart<"code.view.TurnReview", {}>;
  };
  readonly "ReviewPanel": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"code.ReviewPanel.section", Props4>;
  };
  readonly "Note": {
    readonly "p": import("@tokamak/sdk/client").ComponentPart<"code.Note.p", Props5>;
  };
  readonly "TurnReview": {
    readonly "h2": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.h2", Props6> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.h2.span", Props6>;
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.h2.span$2", Props6>;
      readonly "Counts": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.h2.Counts", Props6>;
    };
    readonly "ScrollArea": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea", Props6> & {
      readonly "ul": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.ul", Props6> & {
        readonly "For": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.ul.For", Props6> & {
          readonly "li": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.ul.For.li", Props6> & {
            readonly "Row": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.ul.For.li.Row", Props6> & {
              readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.ul.For.li.Row.Icon", Props6>;
              readonly "FileCounts": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.ul.For.li.Row.FileCounts", Props6>;
              readonly "FileName": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.ul.For.li.Row.FileName", Props6>;
            };
          };
        };
      };
      readonly "Show": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.Show", Props6> & {
        readonly "p": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.Show.p", Props6>;
      };
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.div", Props6> & {
        readonly "For": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.div.For", Props6> & {
          readonly "FilePatch": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.div.For.FilePatch", Props6>;
        };
      };
    };
  };
  readonly "FileCounts": {
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.FileCounts.span", Props3>;
    readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"code.FileCounts.span$2", Props3>;
  };
  readonly "FilePatch": {
    readonly "article": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article", Props7> & {
      readonly "header": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.header", Props7> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.header.span", Props7> & {
          readonly "FileName": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.header.span.FileName", Props7>;
        };
        readonly "Counts": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.header.Counts", Props7>;
      };
      readonly "Show": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.Show", Props7> & {
        readonly "PatchNote": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.Show.PatchNote", Props7>;
      };
      readonly "Switch": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.Switch", Props7> & {
        readonly "Match": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.Switch.Match", Props7> & {
          readonly "PatchNote": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.Switch.Match.PatchNote", Props7>;
        };
        readonly "Match$2": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.Switch.Match$2", Props7> & {
          readonly "div": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.Switch.Match$2.div", Props7> & {
            readonly "For": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.Switch.Match$2.div.For", Props7> & {
              readonly "PatchRow": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.Switch.Match$2.div.For.PatchRow", Props7>;
            };
          };
        };
      };
      readonly "Show$2": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.Show$2", Props7> & {
        readonly "PatchNote": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.Show$2.PatchNote", Props7>;
      };
    };
  };
  readonly "PatchNote": {
    readonly "p": import("@tokamak/sdk/client").ComponentPart<"code.PatchNote.p", Props5>;
  };
  readonly "PatchRow": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div", Props8> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div.span", Props8>;
    };
    readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div$2", Props8>;
    readonly "div$3": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div$3", Props8> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div$3.span", Props8>;
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div$3.span$2", Props8>;
      readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div$3.span$3", Props8>;
      readonly "span$4": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div$3.span$4", Props8>;
    };
  };
  readonly "BranchChip": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"code.BranchChip.Show", Props9> & {
      readonly "Chip": import("@tokamak/sdk/client").ComponentPart<"code.BranchChip.Show.Chip", Props9>;
    };
  };
  readonly "ReviewToggle": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"code.ReviewToggle.Show", Props9> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"code.ReviewToggle.Show.div", Props9> & {
        readonly "Button": import("@tokamak/sdk/client").ComponentPart<"code.ReviewToggle.Show.div.Button", Props9>;
        readonly "Button$2": import("@tokamak/sdk/client").ComponentPart<"code.ReviewToggle.Show.div.Button$2", Props9>;
      };
    };
  };
  readonly "ReviewPanelMount": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"code.ReviewPanelMount.Show", Props9> & {
      readonly "Region$2e$Panel": import("@tokamak/sdk/client").ComponentPart<"code.ReviewPanelMount.Show.Region$2e$Panel", Props9> & {
        readonly "ReviewPanel": import("@tokamak/sdk/client").ComponentPart<"code.ReviewPanelMount.Show.Region$2e$Panel.ReviewPanel", Props9>;
      };
    };
  };
};
