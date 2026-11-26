// Generated plugin screen paths. Commit this file.
export * from "../api";
type Props1 = Extract<NonNullable<{
  agentId: string | undefined;
  modelId?: string | undefined;
  size?: 12 | 14 | 16;
  label?: string;
  class?: string;
}>, object>;
type Props2 = Extract<NonNullable<Props1 & { readonly $row: { readonly item: { d: string; fillRule?: Rule | undefined; clipRule?: Rule | undefined; }; readonly index: () => number } }>, object>;
type Props3 = Extract<NonNullable<{
  current: import("../lib/choices").Resolved;
  /** What the popover sits above: the whole composer, as drawn, rather than the chip alone. */
  anchor: () => HTMLElement | undefined;
  /** Why the agent cannot answer now: only the agent and model column shows then. */
  missing: string | undefined;
  /** Opening asks every agent for its `info` again, so a fresh install or sign-in shows. */
  onOpen: (open: boolean) => void;
  change: (next: import("../lib/choices").Change) => void;
}>, object>;
type Props4 = Extract<NonNullable<{ current: import("../lib/choices").Resolved; missing: string | undefined }>, object>;
type Props5 = Extract<NonNullable<Props4 & { readonly $row: { readonly item: string; readonly index: () => number } }>, object>;
type Props6 = Extract<NonNullable<{
  current: import("../lib/choices").Resolved;
  missing: string | undefined;
  change: (next: import("../lib/choices").Change) => void;
}>, object>;
type Props7 = Extract<NonNullable<Props6 & { readonly $row: { readonly item: import("../lib/agents").AgentEntry; readonly index: () => number } }>, object>;
type Props8 = Extract<NonNullable<Props6 & { readonly $row: { readonly item: string; readonly index: () => number } }>, object>;
type Props9 = Extract<NonNullable<{ children: import("@solidjs/web").JSX.Element }>, object>;
type Props10 = Extract<NonNullable<{ agent: import("../lib/agents").AgentEntry }>, object>;
type Props11 = Extract<NonNullable<Props10 & { readonly $row: { readonly item: { readonly id: string; readonly name: string; readonly efforts: readonly string[]; readonly icon?: string | undefined; }; readonly index: () => number } }>, object>;
type Props12 = Extract<NonNullable<{ current: import("../lib/choices").Resolved; change: (next: import("../lib/choices").Change) => void }>, object>;
type Props13 = Extract<NonNullable<{
  name: string;
  title?: string;
  options: readonly { id: string; label: string }[];
  value: string;
  onPick: (id: string) => void;
}>, object>;
type Props14 = Extract<NonNullable<Props13 & { readonly $row: { readonly item: { id: string; label: string; }; readonly index: () => number } }>, object>;
type Props15 = Extract<NonNullable<import("plugin:chat/client").ComposerProps>, object>;
type Props16 = Extract<NonNullable<{
  client: import("@tokamak/sdk").TokamakClient;
  threadId: string;
  turnLine: () => string | undefined;
}>, object>;
type Props17 = Extract<NonNullable<{
  client: import("@tokamak/sdk").TokamakClient;
  threadId: string | undefined;
  resolved: () => import("../lib/choices").Resolved | undefined;
  turnLine: () => string | undefined;
}>, object>;
type Props18 = Extract<NonNullable<Props15 & { readonly $row: { readonly item: { readonly answer: import("@tokamak/sdk/agent-turn").Answer; readonly label: string; }; readonly index: () => number } }>, object>;
type Props19 = Extract<NonNullable<import("plugin:chat/client").MessageProps>, object>;
type Props20 = Extract<NonNullable<{ tasks: readonly import("@tokamak/sdk/agent-turn").Task[] }>, object>;
type Props21 = Extract<NonNullable<Props20 & { readonly $row: { readonly item: import("@tokamak/sdk/agent-turn").Task; readonly index: () => number } }>, object>;
type Props22 = Extract<NonNullable<{ task: import("@tokamak/sdk/agent-turn").Task }>, object>;
type Props23 = Extract<NonNullable<{ text: string }>, object>;
type Props24 = Extract<NonNullable<{ turn: import("solid-js").Accessor<import("../lib/replies").Turn> }>, object>;
type Props25 = Extract<NonNullable<Props19 & { readonly $row: { readonly item: () => { hasText: boolean; state: "running" | "done" | "failed"; type: "tool" | "helper"; title: string; startedAt: number; turnId: import("@tokamak/sdk").Id<"turns">; n: number; key: string; name?: string | undefined; kind?: "command" | "read" | "edit" | "search" | "web" | "other" | undefined; finishedAt?: number | undefined; detail?: string | undefined; _id: import("@tokamak/sdk").Id<"steps">; _creationTime: number; }; readonly index: () => number } }>, object>;
type Props26 = Extract<NonNullable<{ text: string | null | undefined }>, object>;
type Props27 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient; turnId: import("../lib/replies").Turn["_id"] }>, object>;
type Props28 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient; turn: import("solid-js").Accessor<import("../lib/replies").Turn> }>, object>;
type Props29 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient; turnId: import("../lib/replies").Turn["_id"]; now: number }>, object>;
type Props30 = Extract<NonNullable<Props29 & { readonly $row: { readonly item: () => import("@tokamak/sdk").Doc<import("@tokamak/sdk").ModelFromSchema<import("@tokamak/sdk").SchemaDefinition<{ choices: import("@tokamak/sdk").TableDefinition<{ updatedAt: import("@tokamak/sdk").Validator<number, false>; agent: import("@tokamak/sdk").Validator<{ id: string; name: string; } & {}, false>; model: import("@tokamak/sdk").Validator<string, true>; effort: import("@tokamak/sdk").Validator<string, true>; speed: import("@tokamak/sdk").Validator<string, true>; mode: import("@tokamak/sdk").Validator<string, true>; access: import("@tokamak/sdk").Validator<"full" | "ask", false>; threadId: import("@tokamak/sdk").Validator<string, false>; }, Record<never, never> & Record<"by_threadId", readonly ["threadId"]>>; turns: import("@tokamak/sdk").TableDefinition<{ threadId: import("@tokamak/sdk").Validator<string, false>; messageId: import("@tokamak/sdk").Validator<string, false>; replyId: import("@tokamak/sdk").Validator<string, true>; sender: import("@tokamak/sdk").Validator<{ id: string; name: string; device: string; } & {}, false>; agent: import("@tokamak/sdk").Validator<{ id: string; name: string; } & {}, false>; model: import("@tokamak/sdk").Validator<string, false>; modelName: import("@tokamak/sdk").Validator<string, true>; effort: import("@tokamak/sdk").Validator<string, true>; speed: import("@tokamak/sdk").Validator<string, true>; mode: import("@tokamak/sdk").Validator<string, true>; access: import("@tokamak/sdk").Validator<"full" | "ask", false>; state: import("@tokamak/sdk").Validator<"queued" | "running" | "waiting" | "done" | "stopped" | "failed" | "interrupted", false>; question: import("@tokamak/sdk").Validator<{ id: string; kind: string; action: string; subject: string; } & {}, true>; questionToken: import("@tokamak/sdk").Validator<string, true>; stoppingAt: import("@tokamak/sdk").Validator<number, true>; steers: import("@tokamak/sdk").Validator<string[], true>; steerOffsets: import("@tokamak/sdk").Validator<number[], true>; pendingSteer: import("@tokamak/sdk").Validator<string, true>; pendingSteerOffset: import("@tokamak/sdk").Validator<number, true>; error: import("@tokamak/sdk").Validator<string, true>; usage: import("@tokamak/sdk").Validator<{ inputTokens: number; outputTokens: number; } & { cachedInputTokens?: number | undefined; costUsd?: number | undefined; }, true>; text: import("@tokamak/sdk").Validator<string, true>; thinking: import("@tokamak/sdk").Validator<string, true>; actions: import("@tokamak/sdk").Validator<number, true>; current: import("@tokamak/sdk").Validator<{ type: "tool" | "helper"; title: string; startedAt: number; } & { name?: string | undefined; kind?: "command" | "read" | "edit" | "search" | "web" | "other" | undefined; }, true>; tasks: import("@tokamak/sdk").Validator<({ state: "running" | "done" | "pending"; text: string; } & {})[], true>; plan: import("@tokamak/sdk").Validator<string, true>; sessionId: import("@tokamak/sdk").Validator<string, true>; replyToken: import("@tokamak/sdk").Validator<string, true>; startedAt: import("@tokamak/sdk").Validator<number, false>; finishedAt: import("@tokamak/sdk").Validator<number, true>; }, Record<never, never> & Record<"by_threadId_startedAt", readonly ["threadId", "startedAt"]> & Record<"by_threadId_state", readonly ["threadId", "state"]> & Record<"by_threadId_state_startedAt", readonly ["threadId", "state", "startedAt"]> & Record<"by_state", readonly ["state"]> & Record<"by_messageId", readonly ["messageId"]> & Record<"by_replyId", readonly ["replyId"]>>; steps: import("@tokamak/sdk").TableDefinition<{ turnId: import("@tokamak/sdk").Validator<import("@tokamak/sdk").Id<"turns">, false>; n: import("@tokamak/sdk").Validator<number, false>; key: import("@tokamak/sdk").Validator<string, false>; type: import("@tokamak/sdk").Validator<"tool" | "helper", false>; kind: import("@tokamak/sdk").Validator<"command" | "read" | "edit" | "search" | "web" | "other", true>; name: import("@tokamak/sdk").Validator<string, true>; title: import("@tokamak/sdk").Validator<string, false>; detail: import("@tokamak/sdk").Validator<string, true>; text: import("@tokamak/sdk").Validator<string, true>; state: import("@tokamak/sdk").Validator<"running" | "done" | "failed", false>; startedAt: import("@tokamak/sdk").Validator<number, false>; finishedAt: import("@tokamak/sdk").Validator<number, true>; }, Record<never, never> & Record<"by_turnId_n", readonly ["turnId", "n"]> & Record<"by_turnId_type_n", readonly ["turnId", "type", "n"]> & Record<"by_turnId_key", readonly ["turnId", "key"]>>; signs: import("@tokamak/sdk").TableDefinition<{ turnId: import("@tokamak/sdk").Validator<import("@tokamak/sdk").Id<"turns">, false>; at: import("@tokamak/sdk").Validator<number, false>; }, Record<never, never> & Record<"by_turnId", readonly ["turnId"]>>; sweeps: import("@tokamak/sdk").TableDefinition<{ at: import("@tokamak/sdk").Validator<number, false>; since: import("@tokamak/sdk").Validator<number, false>; }, Record<never, never>>; }>>, "steps">; readonly index: () => number } }>, object>;
type Props31 = Extract<NonNullable<{ step: import("../lib/replies").Step; now: number }>, object>;
type Props32 = Extract<NonNullable<{ step: import("../lib/replies").Step }>, object>;
type Props33 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient; helper: import("../lib/replies").Helper; agentId: string }>, object>;
type Props34 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient; stepId: import("../lib/replies").Helper["_id"] }>, object>;
type Props35 = Extract<NonNullable<{ size?: 12 | 16 }>, object>;
type Props36 = Extract<NonNullable<import("plugin:chat/client").ThreadRowProps>, object>;
type Props37 = Extract<NonNullable<Props36 & { readonly $row: { readonly item: { readonly id: string; readonly name: string; readonly title: string; readonly state: "running" | "done" | "failed"; }; readonly index: () => number } }>, object>;
type Props38 = Extract<NonNullable<Props19 & { readonly $row: { readonly item: () => import("../lib/steers").BodyPiece; readonly index: number } }>, object>;
type Props39 = Extract<NonNullable<{ text: string; sender: string }>, object>;
export declare const parts: {
  readonly "AgentMark": {
    readonly "svg": import("@tokamak/sdk/client").ComponentPart<"ai.AgentMark.svg", Props1> & {
      readonly "path": import("@tokamak/sdk/client").ComponentPart<"ai.AgentMark.svg.path", Props2>;
    };
  };
  readonly "AgentPicker": {
    readonly "Menu$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai.AgentPicker.Menu$2e$Root", Props3> & {
      readonly "PickerChip": import("@tokamak/sdk/client").ComponentPart<"ai.AgentPicker.Menu$2e$Root.PickerChip", Props3>;
      readonly "Menu$2e$Content": import("@tokamak/sdk/client").ComponentPart<"ai.AgentPicker.Menu$2e$Root.Menu$2e$Content", Props3> & {
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.AgentPicker.Menu$2e$Root.Menu$2e$Content.div", Props3> & {
          readonly "PickerColumns": import("@tokamak/sdk/client").ComponentPart<"ai.AgentPicker.Menu$2e$Root.Menu$2e$Content.div.PickerColumns", Props3>;
          readonly "PickerSettings": import("@tokamak/sdk/client").ComponentPart<"ai.AgentPicker.Menu$2e$Root.Menu$2e$Content.div.PickerSettings", Props3>;
        };
      };
    };
  };
  readonly "PickerChip": {
    readonly "Menu$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai.PickerChip.Menu$2e$Trigger", Props4> & {
      readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.PickerChip.Menu$2e$Trigger.AgentMark", Props4>;
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.PickerChip.Menu$2e$Trigger.span", Props4>;
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.PickerChip.Menu$2e$Trigger.span$2", Props4> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.PickerChip.Menu$2e$Trigger.span$2.span", Props5>;
      };
      readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.PickerChip.Menu$2e$Trigger.Icon", Props4>;
    };
  };
  readonly "PickerColumns": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.PickerColumns.div", Props6> & {
      readonly "Menu$2e$RadioGroup": import("@tokamak/sdk/client").ComponentPart<"ai.PickerColumns.div.Menu$2e$RadioGroup", Props6> & {
        readonly "ColumnTitle": import("@tokamak/sdk/client").ComponentPart<"ai.PickerColumns.div.Menu$2e$RadioGroup.ColumnTitle", Props6>;
        readonly "AgentModels": import("@tokamak/sdk/client").ComponentPart<"ai.PickerColumns.div.Menu$2e$RadioGroup.AgentModels", Props7>;
      };
      readonly "Menu$2e$RadioGroup$2": import("@tokamak/sdk/client").ComponentPart<"ai.PickerColumns.div.Menu$2e$RadioGroup$2", Props6> & {
        readonly "ColumnTitle": import("@tokamak/sdk/client").ComponentPart<"ai.PickerColumns.div.Menu$2e$RadioGroup$2.ColumnTitle", Props6>;
        readonly "Menu$2e$RadioItem": import("@tokamak/sdk/client").ComponentPart<"ai.PickerColumns.div.Menu$2e$RadioGroup$2.Menu$2e$RadioItem", Props8>;
      };
    };
  };
  readonly "ColumnTitle": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.ColumnTitle.div", Props9>;
  };
  readonly "AgentModels": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.AgentModels.div", Props10> & {
      readonly "Menu$2e$RadioItem": import("@tokamak/sdk/client").ComponentPart<"ai.AgentModels.div.Menu$2e$RadioItem", Props10> & {
        readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.AgentModels.div.Menu$2e$RadioItem.AgentMark", Props10>;
      };
      readonly "ColumnTitle": import("@tokamak/sdk/client").ComponentPart<"ai.AgentModels.div.ColumnTitle", Props10> & {
        readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.AgentModels.div.ColumnTitle.AgentMark", Props10>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.AgentModels.div.ColumnTitle.span", Props10>;
      };
      readonly "Menu$2e$RadioItem$2": import("@tokamak/sdk/client").ComponentPart<"ai.AgentModels.div.Menu$2e$RadioItem$2", Props11> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.AgentModels.div.Menu$2e$RadioItem$2.span", Props11>;
      };
    };
  };
  readonly "PickerSettings": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.PickerSettings.div", Props12> & {
      readonly "Choice": import("@tokamak/sdk/client").ComponentPart<"ai.PickerSettings.div.Choice", Props12>;
      readonly "Choice$2": import("@tokamak/sdk/client").ComponentPart<"ai.PickerSettings.div.Choice$2", Props12>;
      readonly "Choice$3": import("@tokamak/sdk/client").ComponentPart<"ai.PickerSettings.div.Choice$3", Props12>;
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.PickerSettings.div.span", Props12>;
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.PickerSettings.div.span$2", Props12> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.PickerSettings.div.span$2.span", Props12>;
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.PickerSettings.div.span$2.Icon", Props12>;
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.PickerSettings.div.span$2.span$2", Props12>;
      };
    };
  };
  readonly "Choice": {
    readonly "Menu$2e$RadioGroup": import("@tokamak/sdk/client").ComponentPart<"ai.Choice.Menu$2e$RadioGroup", Props13> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Choice.Menu$2e$RadioGroup.span", Props13>;
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.Choice.Menu$2e$RadioGroup.div", Props13> & {
        readonly "Menu$2e$RadioItem": import("@tokamak/sdk/client").ComponentPart<"ai.Choice.Menu$2e$RadioGroup.div.Menu$2e$RadioItem", Props14>;
      };
    };
  };
  readonly "AgentRow": {
    readonly "Row": import("@tokamak/sdk/client").ComponentPart<"ai.AgentRow.Row", Props15>;
    readonly "OpenThreadRow": import("@tokamak/sdk/client").ComponentPart<"ai.AgentRow.OpenThreadRow", Props15>;
  };
  readonly "OpenThreadRow": {
    readonly "Row": import("@tokamak/sdk/client").ComponentPart<"ai.OpenThreadRow.Row", Props16>;
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.OpenThreadRow.div", Props16> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.OpenThreadRow.div.span", Props16>;
    };
  };
  readonly "Row": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.Row.div", Props17> & {
      readonly "AgentPicker": import("@tokamak/sdk/client").ComponentPart<"ai.Row.div.AgentPicker", Props17>;
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Row.div.span", Props17>;
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.Row.div.span$2", Props17>;
    };
  };
  readonly "AgentHeading": {
    readonly "h2": import("@tokamak/sdk/client").ComponentPart<"ai.AgentHeading.h2", {}>;
  };
  readonly "PermissionCard": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div", Props15> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div", Props15> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div.Icon", Props15>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div.span", Props15>;
        readonly "code": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div.code", Props15>;
      };
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.span", Props15>;
      readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div$2", Props15> & {
        readonly "Tooltip$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div$2.Tooltip$2e$Root", Props18> & {
          readonly "Tooltip$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div$2.Tooltip$2e$Root.Tooltip$2e$Trigger", Props18>;
          readonly "Tooltip$2e$Content": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div$2.Tooltip$2e$Root.Tooltip$2e$Content", Props18> & {
            readonly "Kbd": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div$2.Tooltip$2e$Root.Tooltip$2e$Content.Kbd", Props18>;
          };
        };
      };
    };
  };
  readonly "ReplyCards": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyCards.div", Props19> & {
      readonly "TasksCard": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyCards.div.TasksCard", Props19>;
      readonly "PlanCard": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyCards.div.PlanCard", Props19>;
      readonly "Usage": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyCards.div.Usage", Props19>;
    };
  };
  readonly "TasksCard": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section", Props20> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.div", Props20> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.div.span", Props20> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.div.span.Icon", Props20>;
        };
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.div.span$2", Props20>;
      };
      readonly "ul": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.ul", Props20> & {
        readonly "TaskRow": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.ul.TaskRow", Props21>;
      };
    };
  };
  readonly "TaskRow": {
    readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li", Props22> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li.span", Props22> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li.span.Icon", Props22>;
        readonly "Spinning": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li.span.Spinning", Props22>;
      };
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li.span$2", Props22>;
    };
  };
  readonly "PlanCard": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section", Props23> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section.div", Props23> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section.div.span", Props23> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section.div.span.Icon", Props23>;
        };
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section.div.span$2", Props23>;
      };
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section.p", Props23>;
    };
  };
  readonly "Usage": {
    readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai.Usage.p", Props24>;
  };
  readonly "ReplyHeader": {
    readonly "header": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyHeader.header", Props19> & {
      readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyHeader.header.AgentMark", Props19>;
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyHeader.header.span", Props19>;
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyHeader.header.span$2", Props19>;
    };
  };
  readonly "ReplyWork": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyWork.div", Props19> & {
      readonly "Thinking": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyWork.div.Thinking", Props19>;
      readonly "ActionsLine": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyWork.div.ActionsLine", Props19>;
      readonly "HelperRow": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyWork.div.HelperRow", Props25>;
    };
  };
  readonly "Folded": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.Folded.div", Props9> & {
      readonly "Collapsible$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai.Folded.div.Collapsible$2e$Root", Props9>;
    };
  };
  readonly "FoldedText": {
    readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai.FoldedText.p", Props26>;
  };
  readonly "Thinking": {
    readonly "Collapsible$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root", Props27> & {
      readonly "Collapsible$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root.Collapsible$2e$Trigger", Props27> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root.Collapsible$2e$Trigger.Icon", Props27>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root.Collapsible$2e$Trigger.span", Props27>;
      };
      readonly "Collapsible$2e$Panel": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root.Collapsible$2e$Panel", Props27> & {
        readonly "ThinkingText": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root.Collapsible$2e$Panel.ThinkingText", Props27>;
      };
    };
  };
  readonly "ThinkingText": {
    readonly "FoldedText": import("@tokamak/sdk/client").ComponentPart<"ai.ThinkingText.FoldedText", Props27>;
  };
  readonly "ActionsLine": {
    readonly "Folded": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded", Props28> & {
      readonly "Collapsible$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Trigger", Props28> & {
        readonly "Spinning": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Trigger.Spinning", Props28>;
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Trigger.Icon", Props28>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Trigger.span", Props28>;
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Trigger.span$2", Props28>;
        readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Trigger.span$3", Props28>;
        readonly "span$4": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Trigger.span$4", Props28>;
      };
      readonly "Collapsible$2e$Panel": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Panel", Props28> & {
        readonly "Steps": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Panel.Steps", Props28>;
      };
    };
  };
  readonly "Steps": {
    readonly "ul": import("@tokamak/sdk/client").ComponentPart<"ai.Steps.ul", Props29> & {
      readonly "StepRow": import("@tokamak/sdk/client").ComponentPart<"ai.Steps.ul.StepRow", Props30>;
    };
  };
  readonly "StepRow": {
    readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai.StepRow.li", Props31> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.StepRow.li.span", Props31> & {
        readonly "StepIcon": import("@tokamak/sdk/client").ComponentPart<"ai.StepRow.li.span.StepIcon", Props31>;
      };
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.StepRow.li.span$2", Props31>;
      readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"ai.StepRow.li.span$3", Props31>;
    };
  };
  readonly "StepIcon": {
    readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"ai.StepIcon.StatusIcon", Props32>;
    readonly "StatusIcon$2": import("@tokamak/sdk/client").ComponentPart<"ai.StepIcon.StatusIcon$2", Props32>;
    readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.StepIcon.Icon", Props32>;
  };
  readonly "HelperRow": {
    readonly "Folded": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded", Props33> & {
      readonly "Collapsible$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger", Props33> & {
        readonly "Spinning": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger.Spinning", Props33>;
        readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger.StatusIcon", Props33>;
        readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger.AgentMark", Props33>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger.span", Props33>;
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger.span$2", Props33>;
      };
      readonly "Collapsible$2e$Panel": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Panel", Props33> & {
        readonly "FoldedText": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Panel.FoldedText", Props33>;
        readonly "HelperText": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Panel.HelperText", Props33>;
      };
    };
  };
  readonly "HelperText": {
    readonly "FoldedText": import("@tokamak/sdk/client").ComponentPart<"ai.HelperText.FoldedText", Props34>;
  };
  readonly "Spinning": {
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Spinning.span", Props35> & {
      readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"ai.Spinning.span.StatusIcon", Props35>;
    };
  };
  readonly "ThreadStatusIcon": {
    readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadStatusIcon.StatusIcon", Props36>;
  };
  readonly "ThreadDetail": {
    readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadDetail.AgentMark", Props36>;
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadDetail.span", Props36>;
    readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadDetail.span$2", Props36>;
  };
  readonly "ThreadHelpers": {
    readonly "ul": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul", Props36> & {
      readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.li", Props37> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.li.span", Props37> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.li.span.span", Props37> & {
            readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.li.span.span.AgentMark", Props37>;
          };
          readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.li.span.span$2", Props37>;
          readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.li.span.span$3", Props37>;
          readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.li.span.StatusIcon", Props37>;
        };
      };
    };
  };
  readonly "StopButton": {
    readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai.StopButton.Button", Props15>;
    readonly "Button$2": import("@tokamak/sdk/client").ComponentPart<"ai.StopButton.Button$2", Props15>;
  };
  readonly "SteeredBody": {
    readonly "body": import("@tokamak/sdk/client").ComponentPart<"ai.SteeredBody.body", Props19> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.SteeredBody.body.div", Props38>;
      readonly "Steer": import("@tokamak/sdk/client").ComponentPart<"ai.SteeredBody.body.Steer", Props38>;
    };
  };
  readonly "Steer": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div", Props39> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.span", Props39> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.span.Icon", Props39>;
      };
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.span$2", Props39> & {
        readonly "Avatar": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.span$2.Avatar", Props39>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.span$2.span", Props39>;
      };
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.p", Props39>;
    };
  };
};
