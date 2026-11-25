// Generated plugin screen paths. Commit this file.
export * from "../api";
type Local1 = Exclude<import("@tokamak/sdk").ResultOf<typeof import("../../server/_generated/api").api.changes.diff>, import("@tokamak/sdk").MachineFailure | null>;
type Local2 = Local1["files"][number];
type Local3 = | { readonly kind: "hunk"; readonly text: string }
  | {
      readonly kind: "context" | "added" | "removed" | "note";
      readonly old?: number;
      readonly new?: number;
      readonly text: string;
    };
type Props1 = Extract<NonNullable<import("plugin:chat/client").MessageProps>, object>;
type Props2 = Extract<NonNullable<Props1 & { readonly $row: { readonly item: () => string; readonly index: () => number } }>, object>;
type Props3 = Extract<NonNullable<{ change: import("../lib/changes").ReplyChange }>, object>;
type Props4 = Extract<NonNullable<{ added: number; removed: number }>, object>;
type Props5 = Extract<NonNullable<{ threadId: import("@tokamak/sdk").Id<"threads">; turnId: string | undefined }>, object>;
type Props6 = Extract<NonNullable<{ children: import("@solidjs/web").JSX.Element }>, object>;
type Props7 = Extract<NonNullable<{ number: number; diff: Local1 }>, object>;
type Props8 = Extract<NonNullable<Props7 & { readonly $row: { readonly item: () => import("../../local/changes").FileDiff; readonly index: () => number } }>, object>;
type Props9 = Extract<NonNullable<{ file: Local2 }>, object>;
type Props10 = Extract<NonNullable<Props9 & { readonly $row: { readonly item: { readonly kind: "hunk"; readonly text: string; } | { readonly kind: "added" | "removed" | "context" | "note"; readonly old?: number | undefined; readonly new?: number | undefined; readonly text: string; }; readonly index: () => number } }>, object>;
type Props11 = Extract<NonNullable<{ row: Local3 }>, object>;
type Props12 = Extract<NonNullable<import("plugin:chat/client").HeaderProps>, object>;
export declare const parts: {
  readonly "SnapshotNotice": {
    readonly "p": import("@tokamak/sdk/client").ComponentPart<"code.SnapshotNotice.p", Props1>;
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"code.SnapshotNotice.div", Props1> & {
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"code.SnapshotNotice.div.p", Props1>;
      readonly "ul": import("@tokamak/sdk/client").ComponentPart<"code.SnapshotNotice.div.ul", Props1> & {
        readonly "li": import("@tokamak/sdk/client").ComponentPart<"code.SnapshotNotice.div.ul.li", Props2>;
      };
    };
  };
  readonly "ChangeCard": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.div", Props1> & {
      readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.div.Icon", Props1>;
      readonly "CardText": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.div.CardText", Props1>;
    };
    readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.div$2", Props1> & {
      readonly "Row": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.div$2.Row", Props1> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.div$2.Row.Icon", Props1>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.div$2.Row.span", Props1>;
        readonly "Icon$2": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.div$2.Row.Icon$2", Props1>;
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.div$2.Row.span$2", Props1> & {
          readonly "CardText": import("@tokamak/sdk/client").ComponentPart<"code.ChangeCard.div$2.Row.span$2.CardText", Props1>;
        };
      };
    };
  };
  readonly "CardText": {
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.CardText.span", Props3>;
    readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"code.CardText.span$2", Props3>;
    readonly "Counts": import("@tokamak/sdk/client").ComponentPart<"code.CardText.Counts", Props3>;
  };
  readonly "Counts": {
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.Counts.span", Props4>;
    readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"code.Counts.span$2", Props4>;
  };
  readonly "ReviewPanel": {
    readonly "view": {
      readonly "Note": import("@tokamak/sdk/client").ComponentPart<"code.ReviewPanel.view.Note", Props5>;
      readonly "Note$2": import("@tokamak/sdk/client").ComponentPart<"code.ReviewPanel.view.Note$2", Props5>;
      readonly "Note$3": import("@tokamak/sdk/client").ComponentPart<"code.ReviewPanel.view.Note$3", Props5>;
      readonly "Note$4": import("@tokamak/sdk/client").ComponentPart<"code.ReviewPanel.view.Note$4", Props5>;
      readonly "TurnReview": import("@tokamak/sdk/client").ComponentPart<"code.ReviewPanel.view.TurnReview", Props5>;
    };
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"code.ReviewPanel.section", Props5>;
  };
  readonly "Note": {
    readonly "p": import("@tokamak/sdk/client").ComponentPart<"code.Note.p", Props6>;
  };
  readonly "TurnReview": {
    readonly "h2": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.h2", Props7> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.h2.span", Props7>;
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.h2.span$2", Props7>;
      readonly "Counts": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.h2.Counts", Props7>;
    };
    readonly "ScrollArea": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea", Props7> & {
      readonly "ul": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.ul", Props7> & {
        readonly "li": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.ul.li", Props8> & {
          readonly "Row": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.ul.li.Row", Props8> & {
            readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.ul.li.Row.Icon", Props8>;
            readonly "FileCounts": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.ul.li.Row.FileCounts", Props8>;
            readonly "FileName": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.ul.li.Row.FileName", Props8>;
          };
        };
      };
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.p", Props7>;
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.div", Props7> & {
        readonly "FilePatch": import("@tokamak/sdk/client").ComponentPart<"code.TurnReview.ScrollArea.div.FilePatch", Props8>;
      };
    };
  };
  readonly "FileCounts": {
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.FileCounts.span", Props4>;
    readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"code.FileCounts.span$2", Props4>;
  };
  readonly "FilePatch": {
    readonly "article": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article", Props9> & {
      readonly "header": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.header", Props9> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.header.span", Props9> & {
          readonly "FileName": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.header.span.FileName", Props9>;
        };
        readonly "Counts": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.header.Counts", Props9>;
      };
      readonly "PatchNote": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.PatchNote", Props9>;
      readonly "PatchNote$2": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.PatchNote$2", Props9>;
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.div", Props9> & {
        readonly "PatchRow": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.div.PatchRow", Props10>;
      };
      readonly "PatchNote$3": import("@tokamak/sdk/client").ComponentPart<"code.FilePatch.article.PatchNote$3", Props9>;
    };
  };
  readonly "PatchNote": {
    readonly "p": import("@tokamak/sdk/client").ComponentPart<"code.PatchNote.p", Props6>;
  };
  readonly "PatchRow": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div", Props11> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div.span", Props11>;
    };
    readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div$2", Props11>;
    readonly "div$3": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div$3", Props11> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div$3.span", Props11>;
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div$3.span$2", Props11>;
      readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div$3.span$3", Props11>;
      readonly "span$4": import("@tokamak/sdk/client").ComponentPart<"code.PatchRow.div$3.span$4", Props11>;
    };
  };
  readonly "BranchChip": {
    readonly "Chip": import("@tokamak/sdk/client").ComponentPart<"code.BranchChip.Chip", Props12>;
  };
  readonly "ReviewToggle": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"code.ReviewToggle.div", Props12> & {
      readonly "Button": import("@tokamak/sdk/client").ComponentPart<"code.ReviewToggle.div.Button", Props12>;
      readonly "Button$2": import("@tokamak/sdk/client").ComponentPart<"code.ReviewToggle.div.Button$2", Props12>;
    };
  };
  readonly "ReviewPanelMount": {
    readonly "Region$2e$Panel": import("@tokamak/sdk/client").ComponentPart<"code.ReviewPanelMount.Region$2e$Panel", Props12> & {
      readonly "ReviewPanel": import("@tokamak/sdk/client").ComponentPart<"code.ReviewPanelMount.Region$2e$Panel.ReviewPanel", Props12>;
    };
  };
};
