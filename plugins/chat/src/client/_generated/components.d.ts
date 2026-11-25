// Generated plugin screen paths. Commit this file.
export * from "../api";
type Props1 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient }>, object>;
type Props2 = Extract<NonNullable<{
  client: import("@tokamak/sdk").TokamakClient;
  threadId: import("@tokamak/sdk").Id<"threads">;
  folder: import("../../server/folders/folder").Folder | undefined;
}>, object>;
type Props3 = Extract<NonNullable<{ extra?: string }>, object>;
type Props4 = Extract<NonNullable<Parameters<typeof import("../api")["Composer"]>[0]>, object>;
type Props5 = Extract<NonNullable<{ disabled: boolean; onSend: () => void }>, object>;
type Props6 = Extract<NonNullable<Parameters<typeof import("../api")["Empty"]>[0]>, object>;
type Props7 = Extract<NonNullable<import("../ui/empty").EmptyProps>, object>;
type Props8 = Extract<NonNullable<{
  icon: string;
  label: string;
  detail?: string;
  checked: boolean;
  /** "Choose a folder…" is a plain button: it opens a dialog rather than picking. */
  opensDialog?: boolean;
  onPick: () => void;
}>, object>;
type Props9 = Extract<NonNullable<Parameters<typeof import("../api")["Message"]>[0]>, object>;
type Props10 = Extract<NonNullable<Parameters<typeof import("../api")["Header"]>[0]>, object>;
type Props11 = Extract<NonNullable<{ path: string | undefined }>, object>;
type Props12 = Extract<NonNullable<{ onRename: () => void; onDelete: () => void }>, object>;
type Props13 = Extract<NonNullable<{
  title: string;
  open: boolean;
  busy: boolean;
  failure: string | undefined;
  onOpenChange: (open: boolean) => void;
  onDelete: () => void;
}>, object>;
type Props14 = Extract<NonNullable<{ title: string; onDone: (title: string) => void }>, object>;
type Props15 = Extract<NonNullable<Parameters<typeof import("../api")["ThreadRow"]>[0]>, object>;
type Props16 = Extract<NonNullable<{
  threads: readonly import("../lib/api").Thread[] | undefined;
  current: import("@tokamak/sdk").Id<"threads"> | undefined;
  onOpen: (id: import("@tokamak/sdk").Id<"threads">) => void;
  onNew: () => void;
}>, object>;
export declare const parts: {
  readonly "Chat": {
    readonly "Region$2e$Sidebar": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.Region$2e$Sidebar", {}> & {
      readonly "ThreadList": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.Region$2e$Sidebar.ThreadList", {}>;
    };
    readonly "Region$2e$Header": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.Region$2e$Header", {}> & {
      readonly "Show": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.Region$2e$Header.Show", {}> & {
        readonly "Header": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.Region$2e$Header.Show.Header", {}>;
      };
    };
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.section", {}> & {
      readonly "Show": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.section.Show", {}> & {
        readonly "NewThread": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.section.Show.NewThread", {}>;
        readonly "OpenThread": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.section.Show.OpenThread", {}>;
      };
    };
  };
  readonly "NewThread": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.NewThread.div", Props1> & {
      readonly "Empty": import("@tokamak/sdk/client").ComponentPart<"chat.NewThread.div.Empty", Props1>;
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.NewThread.div.div", Props1> & {
        readonly "ErrorLine": import("@tokamak/sdk/client").ComponentPart<"chat.NewThread.div.div.ErrorLine", Props1>;
        readonly "Composer": import("@tokamak/sdk/client").ComponentPart<"chat.NewThread.div.div.Composer", Props1>;
      };
    };
  };
  readonly "OpenThread": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.OpenThread.div", Props2> & {
      readonly "ScrollArea": import("@tokamak/sdk/client").ComponentPart<"chat.OpenThread.div.ScrollArea", Props2> & {
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.OpenThread.div.ScrollArea.div", Props2> & {
          readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.OpenThread.div.ScrollArea.div.div", Props2> & {
            readonly "For": import("@tokamak/sdk/client").ComponentPart<"chat.OpenThread.div.ScrollArea.div.div.For", Props2> & {
              readonly "Message": import("@tokamak/sdk/client").ComponentPart<"chat.OpenThread.div.ScrollArea.div.div.For.Message", Props2>;
            };
          };
        };
      };
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.OpenThread.div.div", Props2> & {
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.OpenThread.div.div.div", Props2> & {
          readonly "ErrorLine": import("@tokamak/sdk/client").ComponentPart<"chat.OpenThread.div.div.div.ErrorLine", Props2>;
          readonly "Composer": import("@tokamak/sdk/client").ComponentPart<"chat.OpenThread.div.div.div.Composer", Props2>;
        };
      };
    };
  };
  readonly "ErrorLine": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"chat.ErrorLine.Show", Props3> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.ErrorLine.Show.div", Props3> & {
        readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"chat.ErrorLine.Show.div.StatusIcon", Props3>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.ErrorLine.Show.div.span", Props3>;
        readonly "Button": import("@tokamak/sdk/client").ComponentPart<"chat.ErrorLine.Show.div.Button", Props3>;
      };
    };
  };
  readonly "Composer": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div", Props4> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div.div", Props4>;
      readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div.div$2", Props4> & {
        readonly "Textarea": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div.div$2.Textarea", Props4>;
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div.div$2.div", Props4> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div.div$2.div.span", Props4>;
          readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div.div$2.div.span$2", Props4>;
          readonly "SendButton": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div.div$2.div.SendButton", Props4>;
        };
      };
    };
  };
  readonly "SendButton": {
    readonly "Button": import("@tokamak/sdk/client").ComponentPart<"chat.SendButton.Button", Props5>;
  };
  readonly "Empty": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Empty.div", Props6> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Empty.div.div", Props6> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.Empty.div.div.span", Props6> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"chat.Empty.div.div.span.Icon", Props6>;
        };
        readonly "h2": import("@tokamak/sdk/client").ComponentPart<"chat.Empty.div.div.h2", Props6>;
      };
      readonly "FolderPicker": import("@tokamak/sdk/client").ComponentPart<"chat.Empty.div.FolderPicker", Props6>;
    };
  };
  readonly "FolderPicker": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div", Props7> & {
      readonly "For": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.For", Props7> & {
        readonly "Choice": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.For.Choice", Props7>;
      };
      readonly "Choice": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Choice", Props7>;
      readonly "Choice$2": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Choice$2", Props7>;
      readonly "Dialog$2e$Root": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root", Props7> & {
        readonly "Dialog$2e$Backdrop": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Backdrop", Props7>;
        readonly "Dialog$2e$Content": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content", Props7> & {
          readonly "Dialog$2e$Title": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.Dialog$2e$Title", Props7>;
          readonly "Dialog$2e$Description": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.Dialog$2e$Description", Props7>;
          readonly "form": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.form", Props7> & {
            readonly "Textarea": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.form.Textarea", Props7>;
            readonly "Show": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.form.Show", Props7> & {
              readonly "p": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.form.Show.p", Props7>;
            };
            readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.form.div", Props7> & {
              readonly "Dialog$2e$Close": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.form.div.Dialog$2e$Close", Props7>;
              readonly "Button": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.form.div.Button", Props7>;
            };
          };
        };
      };
    };
  };
  readonly "Choice": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Choice.div", Props8> & {
      readonly "Row": import("@tokamak/sdk/client").ComponentPart<"chat.Choice.div.Row", Props8> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"chat.Choice.div.Row.Icon", Props8>;
        readonly "Icon$2": import("@tokamak/sdk/client").ComponentPart<"chat.Choice.div.Row.Icon$2", Props8>;
      };
    };
  };
  readonly "Message": {
    readonly "article": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article", Props9> & {
      readonly "header": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.header", Props9> & {
        readonly "Avatar": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.header.Avatar", Props9>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.header.span", Props9>;
        readonly "time": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.header.time", Props9>;
      };
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.div", Props9> & {
        readonly "Show": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.div.Show", Props9> & {
          readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.div.Show.div", Props9>;
        };
      };
      readonly "Show": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.Show", Props9> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.Show.span", Props9>;
      };
      readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.div$2", Props9>;
    };
  };
  readonly "Header": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div", Props10> & {
      readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.Icon", Props10>;
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.div", Props10> & {
        readonly "Show": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.div.Show", Props10> & {
          readonly "h1": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.div.Show.h1", Props10>;
          readonly "TitleInput": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.div.Show.TitleInput", Props10>;
        };
      };
      readonly "FolderChip": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.FolderChip", Props10>;
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.span", Props10>;
      readonly "ThreadMenu": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.ThreadMenu", Props10>;
      readonly "DeleteDialog": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.DeleteDialog", Props10>;
    };
  };
  readonly "FolderChip": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"chat.FolderChip.Show", Props11> & {
      readonly "Chip": import("@tokamak/sdk/client").ComponentPart<"chat.FolderChip.Show.Chip", Props11>;
    };
  };
  readonly "ThreadMenu": {
    readonly "Menu$2e$Root": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root", Props12> & {
      readonly "Menu$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root.Menu$2e$Trigger", Props12>;
      readonly "Menu$2e$Content": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root.Menu$2e$Content", Props12> & {
        readonly "Menu$2e$Item": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root.Menu$2e$Content.Menu$2e$Item", Props12> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root.Menu$2e$Content.Menu$2e$Item.Icon", Props12>;
        };
        readonly "Menu$2e$Separator": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root.Menu$2e$Content.Menu$2e$Separator", Props12>;
        readonly "Menu$2e$Item$2": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root.Menu$2e$Content.Menu$2e$Item$2", Props12> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root.Menu$2e$Content.Menu$2e$Item$2.Icon", Props12>;
        };
      };
    };
  };
  readonly "DeleteDialog": {
    readonly "Dialog$2e$Root": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root", Props13> & {
      readonly "Dialog$2e$Backdrop": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Backdrop", Props13>;
      readonly "Dialog$2e$Content": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Content", Props13> & {
        readonly "Dialog$2e$Title": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Content.Dialog$2e$Title", Props13>;
        readonly "Dialog$2e$Description": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Content.Dialog$2e$Description", Props13>;
        readonly "Show": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Content.Show", Props13> & {
          readonly "p": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Content.Show.p", Props13>;
        };
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Content.div", Props13> & {
          readonly "Dialog$2e$Close": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Content.div.Dialog$2e$Close", Props13>;
          readonly "Button": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Content.div.Button", Props13>;
        };
      };
    };
  };
  readonly "TitleInput": {
    readonly "input": import("@tokamak/sdk/client").ComponentPart<"chat.TitleInput.input", Props14>;
  };
  readonly "ThreadRow": {
    readonly "ListboxItem": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadRow.ListboxItem", Props15> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadRow.ListboxItem.span", Props15> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadRow.ListboxItem.span.span", Props15> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadRow.ListboxItem.span.span.span", Props15>;
          readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadRow.ListboxItem.span.span.span$2", Props15>;
          readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadRow.ListboxItem.span.span.span$3", Props15>;
        };
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadRow.ListboxItem.span.span$2", Props15>;
      };
    };
  };
  readonly "ThreadList": {
    readonly "nav": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav", Props16> & {
      readonly "Row": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav.Row", Props16> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav.Row.Icon", Props16>;
        readonly "Kbd": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav.Row.Kbd", Props16>;
      };
      readonly "Show": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav.Show", Props16> & {
        readonly "RowList$2e$Root": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav.Show.RowList$2e$Root", Props16> & {
          readonly "RowList$2e$Group": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav.Show.RowList$2e$Root.RowList$2e$Group", Props16> & {
            readonly "For": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav.Show.RowList$2e$Root.RowList$2e$Group.For", Props16> & {
              readonly "ThreadRow": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav.Show.RowList$2e$Root.RowList$2e$Group.For.ThreadRow", Props16>;
            };
          };
        };
      };
    };
  };
};
