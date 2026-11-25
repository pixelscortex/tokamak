// Generated plugin screen paths. Commit this file.
export * from "../api";
type Props1 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient }>, object>;
type Props2 = Extract<NonNullable<{
  client: import("@tokamak/sdk").TokamakClient;
  threadId: import("@tokamak/sdk").Id<"threads">;
  folder: import("../../server/folders/folder").Folder | undefined;
}>, object>;
type Props3 = Extract<NonNullable<Props2 & { readonly $row: { readonly item: () => { createdAt: number; threadId: import("@tokamak/sdk").Id<"threads">; role: "user" | "assistant"; parts: (({ type: "text"; text: string; } & {}) | ({ plugin: string; type: "tool"; callId: string; toolName: string; args: import("@tokamak/sdk").JsonValue; status: "running" | "done" | "error"; } & { error?: string | undefined; result?: import("@tokamak/sdk").JsonValue | undefined; summary?: string | undefined; model?: string | undefined; view?: string | undefined; }) | ({ entries: ({ status: string; content: string; priority: string; } & {})[]; type: "plan"; } & {}) | ({ title: string; type: "permission"; callId: string; status: "pending" | "answered" | "expired" | "cancelled"; requestId: string; options: ({ kind: string; name: string; optionId: string; } & {})[]; } & { optionId?: string | undefined; }))[]; status: "error" | "cancelled" | "queued" | "streaming" | "complete" | "interrupted"; author?: ({ id: string; name: string; } & {}) | undefined; askedBy?: ({ id: string; name: string; } & {}) | undefined; error?: string | undefined; agent?: ({ plugin: string; backendId: string; } & {}) | undefined; _id: import("@tokamak/sdk").Id<"messages">; _creationTime: number; } & { tooLarge?: true | undefined; }; readonly index: () => number } }>, object>;
type Props4 = Extract<NonNullable<{ extra?: string }>, object>;
type Props5 = Extract<NonNullable<Parameters<typeof import("../api")["Composer"]>[0]>, object>;
type Props6 = Extract<NonNullable<{ disabled: boolean; onSend: () => void }>, object>;
type Props7 = Extract<NonNullable<Parameters<typeof import("../api")["Empty"]>[0]>, object>;
type Props8 = Extract<NonNullable<import("../ui/empty").EmptyProps>, object>;
type Props9 = Extract<NonNullable<Props8 & { readonly $row: { readonly item: string; readonly index: () => number } }>, object>;
type Props10 = Extract<NonNullable<{
  icon: string;
  label: string;
  detail?: string;
  checked: boolean;
  /** "Choose a folder…" is a plain button: it opens a dialog rather than picking. */
  opensDialog?: boolean;
  onPick: () => void;
}>, object>;
type Props11 = Extract<NonNullable<Parameters<typeof import("../api")["Message"]>[0]>, object>;
type Props12 = Extract<NonNullable<Parameters<typeof import("../api")["Header"]>[0]>, object>;
type Props13 = Extract<NonNullable<{ path: string | undefined }>, object>;
type Props14 = Extract<NonNullable<{ onRename: () => void; onDelete: () => void }>, object>;
type Props15 = Extract<NonNullable<{
  title: string;
  open: boolean;
  busy: boolean;
  failure: string | undefined;
  onOpenChange: (open: boolean) => void;
  onDelete: () => void;
}>, object>;
type Props16 = Extract<NonNullable<{ title: string; onDone: (title: string) => void }>, object>;
type Props17 = Extract<NonNullable<Parameters<typeof import("../api")["ThreadRow"]>[0]>, object>;
type Props18 = Extract<NonNullable<{
  threads: readonly import("../lib/api").Thread[] | undefined;
  current: import("@tokamak/sdk").Id<"threads"> | undefined;
  onOpen: (id: import("@tokamak/sdk").Id<"threads">) => void;
  onNew: () => void;
}>, object>;
type Props19 = Extract<NonNullable<Props18 & { readonly $row: { readonly item: () => import("../lib/api").Thread; readonly index: () => number } }>, object>;
export declare const parts: {
  readonly "Chat": {
    readonly "Region$2e$Sidebar": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.Region$2e$Sidebar", {}> & {
      readonly "ThreadList": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.Region$2e$Sidebar.ThreadList", {}>;
    };
    readonly "Region$2e$Header": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.Region$2e$Header", {}> & {
      readonly "Header": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.Region$2e$Header.Header", {}>;
    };
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.section", {}> & {
      readonly "NewThread": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.section.NewThread", {}>;
      readonly "OpenThread": import("@tokamak/sdk/client").ComponentPart<"chat.Chat.section.OpenThread", {}>;
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
            readonly "Message": import("@tokamak/sdk/client").ComponentPart<"chat.OpenThread.div.ScrollArea.div.div.Message", Props3>;
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
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.ErrorLine.div", Props4> & {
      readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"chat.ErrorLine.div.StatusIcon", Props4>;
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.ErrorLine.div.span", Props4>;
      readonly "Button": import("@tokamak/sdk/client").ComponentPart<"chat.ErrorLine.div.Button", Props4>;
    };
  };
  readonly "Composer": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div", Props5> & {
      readonly "top": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div.top", Props5>;
      readonly "box": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div.box", Props5> & {
        readonly "Textarea": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div.box.Textarea", Props5>;
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div.box.div", Props5> & {
          readonly "tools": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div.box.div.tools", Props5>;
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div.box.div.span", Props5>;
          readonly "SendButton": import("@tokamak/sdk/client").ComponentPart<"chat.Composer.div.box.div.SendButton", Props5>;
        };
      };
    };
  };
  readonly "SendButton": {
    readonly "Button": import("@tokamak/sdk/client").ComponentPart<"chat.SendButton.Button", Props6>;
  };
  readonly "Empty": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Empty.div", Props7> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Empty.div.div", Props7> & {
        readonly "icon": import("@tokamak/sdk/client").ComponentPart<"chat.Empty.div.div.icon", Props7> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"chat.Empty.div.div.icon.Icon", Props7>;
        };
        readonly "heading": import("@tokamak/sdk/client").ComponentPart<"chat.Empty.div.div.heading", Props7>;
      };
      readonly "FolderPicker": import("@tokamak/sdk/client").ComponentPart<"chat.Empty.div.FolderPicker", Props7>;
    };
  };
  readonly "FolderPicker": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div", Props8> & {
      readonly "Choice": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Choice", Props9>;
      readonly "Choice$2": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Choice$2", Props8>;
      readonly "Choice$3": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Choice$3", Props8>;
      readonly "Dialog$2e$Root": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root", Props8> & {
        readonly "Dialog$2e$Backdrop": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Backdrop", Props8>;
        readonly "Dialog$2e$Content": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content", Props8> & {
          readonly "Dialog$2e$Title": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.Dialog$2e$Title", Props8>;
          readonly "Dialog$2e$Description": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.Dialog$2e$Description", Props8>;
          readonly "form": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.form", Props8> & {
            readonly "Textarea": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.form.Textarea", Props8>;
            readonly "p": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.form.p", Props8>;
            readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.form.div", Props8> & {
              readonly "Dialog$2e$Close": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.form.div.Dialog$2e$Close", Props8>;
              readonly "Button": import("@tokamak/sdk/client").ComponentPart<"chat.FolderPicker.div.Dialog$2e$Root.Dialog$2e$Content.form.div.Button", Props8>;
            };
          };
        };
      };
    };
  };
  readonly "Choice": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Choice.div", Props10> & {
      readonly "Row": import("@tokamak/sdk/client").ComponentPart<"chat.Choice.div.Row", Props10> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"chat.Choice.div.Row.Icon", Props10>;
        readonly "Icon$2": import("@tokamak/sdk/client").ComponentPart<"chat.Choice.div.Row.Icon$2", Props10>;
      };
    };
  };
  readonly "Message": {
    readonly "article": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article", Props11> & {
      readonly "header": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.header", Props11> & {
        readonly "Avatar": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.header.Avatar", Props11>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.header.span", Props11>;
        readonly "time": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.header.time", Props11>;
      };
      readonly "body": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.body", Props11> & {
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.body.div", Props11>;
      };
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.span", Props11>;
      readonly "footer": import("@tokamak/sdk/client").ComponentPart<"chat.Message.article.footer", Props11>;
    };
  };
  readonly "Header": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div", Props12> & {
      readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.Icon", Props12>;
      readonly "title": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.title", Props12> & {
        readonly "h1": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.title.h1", Props12>;
        readonly "TitleInput": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.title.TitleInput", Props12>;
      };
      readonly "FolderChip": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.FolderChip", Props12>;
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.span", Props12>;
      readonly "ThreadMenu": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.ThreadMenu", Props12>;
      readonly "DeleteDialog": import("@tokamak/sdk/client").ComponentPart<"chat.Header.div.DeleteDialog", Props12>;
    };
  };
  readonly "FolderChip": {
    readonly "Chip": import("@tokamak/sdk/client").ComponentPart<"chat.FolderChip.Chip", Props13>;
  };
  readonly "ThreadMenu": {
    readonly "Menu$2e$Root": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root", Props14> & {
      readonly "Menu$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root.Menu$2e$Trigger", Props14>;
      readonly "Menu$2e$Content": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root.Menu$2e$Content", Props14> & {
        readonly "Menu$2e$Item": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root.Menu$2e$Content.Menu$2e$Item", Props14> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root.Menu$2e$Content.Menu$2e$Item.Icon", Props14>;
        };
        readonly "Menu$2e$Separator": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root.Menu$2e$Content.Menu$2e$Separator", Props14>;
        readonly "Menu$2e$Item$2": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root.Menu$2e$Content.Menu$2e$Item$2", Props14> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadMenu.Menu$2e$Root.Menu$2e$Content.Menu$2e$Item$2.Icon", Props14>;
        };
      };
    };
  };
  readonly "DeleteDialog": {
    readonly "Dialog$2e$Root": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root", Props15> & {
      readonly "Dialog$2e$Backdrop": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Backdrop", Props15>;
      readonly "Dialog$2e$Content": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Content", Props15> & {
        readonly "Dialog$2e$Title": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Content.Dialog$2e$Title", Props15>;
        readonly "Dialog$2e$Description": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Content.Dialog$2e$Description", Props15>;
        readonly "p": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Content.p", Props15>;
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Content.div", Props15> & {
          readonly "Dialog$2e$Close": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Content.div.Dialog$2e$Close", Props15>;
          readonly "Button": import("@tokamak/sdk/client").ComponentPart<"chat.DeleteDialog.Dialog$2e$Root.Dialog$2e$Content.div.Button", Props15>;
        };
      };
    };
  };
  readonly "TitleInput": {
    readonly "input": import("@tokamak/sdk/client").ComponentPart<"chat.TitleInput.input", Props16>;
  };
  readonly "ThreadRow": {
    readonly "ListboxItem": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadRow.ListboxItem", Props17> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadRow.ListboxItem.span", Props17> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadRow.ListboxItem.span.span", Props17> & {
          readonly "status": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadRow.ListboxItem.span.span.status", Props17>;
          readonly "title": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadRow.ListboxItem.span.span.title", Props17>;
          readonly "age": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadRow.ListboxItem.span.span.age", Props17>;
        };
        readonly "detail": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadRow.ListboxItem.span.detail", Props17>;
      };
    };
  };
  readonly "ThreadList": {
    readonly "nav": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav", Props18> & {
      readonly "Row": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav.Row", Props18> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav.Row.Icon", Props18>;
        readonly "Kbd": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav.Row.Kbd", Props18>;
      };
      readonly "RowList$2e$Root": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav.RowList$2e$Root", Props18> & {
        readonly "RowList$2e$Group": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav.RowList$2e$Root.RowList$2e$Group", Props18> & {
          readonly "ThreadRow": import("@tokamak/sdk/client").ComponentPart<"chat.ThreadList.nav.RowList$2e$Root.RowList$2e$Group.ThreadRow", Props19>;
        };
      };
    };
  };
};
