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
type Props3 = Extract<NonNullable<import("plugin:chat/client").ComposerProps>, object>;
type Props4 = Extract<NonNullable<{
  client: import("@tokamak/sdk").TokamakClient;
  threadId: string;
  turnLine: () => string | undefined;
}>, object>;
type Props5 = Extract<NonNullable<{
  client: import("@tokamak/sdk").TokamakClient;
  threadId: string | undefined;
  resolved: () => import("../lib/choices").Resolved | undefined;
  turnLine: () => string | undefined;
}>, object>;
type Props6 = Extract<NonNullable<{
  current: import("../lib/choices").Resolved;
  refresh: (open: boolean) => void;
  change: (current: import("../lib/choices").Resolved, next: import("../lib/choices").Change) => void;
}>, object>;
type Props7 = Extract<NonNullable<Props6 & { readonly $row: { readonly item: { readonly name: string; readonly key: keyof import("../../shared/offered").Picked; readonly options: (current: import("../lib/choices").Resolved) => readonly { id: string; label: string; }[]; readonly value: (current: import("../lib/choices").Resolved) => string | undefined; }; readonly index: () => number } }>, object>;
type Props8 = Extract<NonNullable<{
  name: string;
  options: readonly { id: string; label: string }[];
  /** Opens even with one option (or none): opening asks the agents again. */
  always?: boolean;
  /** A mark before the value (the agent's logo). */
  lead?: import("@solidjs/web").JSX.Element;
  onOpen: (open: boolean) => void;
  onPick: (id: string) => void;
  children: import("@solidjs/web").JSX.Element;
}>, object>;
type Props9 = Extract<NonNullable<Props8 & { readonly $row: { readonly item: { id: string; label: string; }; readonly index: () => number } }>, object>;
type Props10 = Extract<NonNullable<Props3 & { readonly $row: { readonly item: { readonly answer: import("@tokamak/sdk/agent-turn").Answer; readonly label: string; }; readonly index: () => number } }>, object>;
type Props11 = Extract<NonNullable<import("plugin:chat/client").MessageProps>, object>;
type Props12 = Extract<NonNullable<{ tasks: readonly import("@tokamak/sdk/agent-turn").Task[] }>, object>;
type Props13 = Extract<NonNullable<Props12 & { readonly $row: { readonly item: import("@tokamak/sdk/agent-turn").Task; readonly index: () => number } }>, object>;
type Props14 = Extract<NonNullable<{ task: import("@tokamak/sdk/agent-turn").Task }>, object>;
type Props15 = Extract<NonNullable<{ text: string }>, object>;
type Props16 = Extract<NonNullable<{ turn: import("solid-js").Accessor<import("../lib/replies").Turn> }>, object>;
type Props17 = Extract<NonNullable<Props11 & { readonly $row: { readonly item: () => { hasText: boolean; state: "running" | "done" | "failed"; type: "tool" | "helper"; title: string; startedAt: number; turnId: import("@tokamak/sdk").Id<"turns">; n: number; key: string; name?: string | undefined; kind?: "command" | "read" | "edit" | "search" | "web" | "other" | undefined; finishedAt?: number | undefined; detail?: string | undefined; _id: import("@tokamak/sdk").Id<"steps">; _creationTime: number; }; readonly index: () => number } }>, object>;
type Props18 = Extract<NonNullable<{ children: import("@solidjs/web").JSX.Element }>, object>;
type Props19 = Extract<NonNullable<{ text: string | null | undefined }>, object>;
type Props20 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient; turnId: import("../lib/replies").Turn["_id"] }>, object>;
type Props21 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient; turn: import("solid-js").Accessor<import("../lib/replies").Turn> }>, object>;
type Props22 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient; turnId: import("../lib/replies").Turn["_id"]; now: number }>, object>;
type Props23 = Extract<NonNullable<Props22 & { readonly $row: { readonly item: () => import("@tokamak/sdk").Doc<import("@tokamak/sdk").ModelFromSchema<import("@tokamak/sdk").SchemaDefinition<{ choices: import("@tokamak/sdk").TableDefinition<{ updatedAt: import("@tokamak/sdk").Validator<number, false>; agent: import("@tokamak/sdk").Validator<{ id: string; name: string; } & {}, false>; model: import("@tokamak/sdk").Validator<string, true>; effort: import("@tokamak/sdk").Validator<string, true>; speed: import("@tokamak/sdk").Validator<string, true>; mode: import("@tokamak/sdk").Validator<string, true>; access: import("@tokamak/sdk").Validator<"full" | "ask", false>; threadId: import("@tokamak/sdk").Validator<string, false>; }, Record<never, never> & Record<"by_threadId", readonly ["threadId"]>>; turns: import("@tokamak/sdk").TableDefinition<{ threadId: import("@tokamak/sdk").Validator<string, false>; messageId: import("@tokamak/sdk").Validator<string, false>; replyId: import("@tokamak/sdk").Validator<string, true>; sender: import("@tokamak/sdk").Validator<{ id: string; name: string; device: string; } & {}, false>; agent: import("@tokamak/sdk").Validator<{ id: string; name: string; } & {}, false>; model: import("@tokamak/sdk").Validator<string, false>; modelName: import("@tokamak/sdk").Validator<string, true>; effort: import("@tokamak/sdk").Validator<string, true>; speed: import("@tokamak/sdk").Validator<string, true>; mode: import("@tokamak/sdk").Validator<string, true>; access: import("@tokamak/sdk").Validator<"full" | "ask", false>; state: import("@tokamak/sdk").Validator<"queued" | "running" | "waiting" | "done" | "stopped" | "failed" | "interrupted", false>; question: import("@tokamak/sdk").Validator<{ id: string; kind: string; action: string; subject: string; } & {}, true>; questionToken: import("@tokamak/sdk").Validator<string, true>; stoppingAt: import("@tokamak/sdk").Validator<number, true>; steers: import("@tokamak/sdk").Validator<string[], true>; steerOffsets: import("@tokamak/sdk").Validator<number[], true>; pendingSteer: import("@tokamak/sdk").Validator<string, true>; pendingSteerOffset: import("@tokamak/sdk").Validator<number, true>; error: import("@tokamak/sdk").Validator<string, true>; usage: import("@tokamak/sdk").Validator<{ inputTokens: number; outputTokens: number; } & { cachedInputTokens?: number | undefined; costUsd?: number | undefined; }, true>; text: import("@tokamak/sdk").Validator<string, true>; thinking: import("@tokamak/sdk").Validator<string, true>; actions: import("@tokamak/sdk").Validator<number, true>; current: import("@tokamak/sdk").Validator<{ type: "tool" | "helper"; title: string; startedAt: number; } & { name?: string | undefined; kind?: "command" | "read" | "edit" | "search" | "web" | "other" | undefined; }, true>; tasks: import("@tokamak/sdk").Validator<({ state: "running" | "done" | "pending"; text: string; } & {})[], true>; plan: import("@tokamak/sdk").Validator<string, true>; sessionId: import("@tokamak/sdk").Validator<string, true>; replyToken: import("@tokamak/sdk").Validator<string, true>; startedAt: import("@tokamak/sdk").Validator<number, false>; finishedAt: import("@tokamak/sdk").Validator<number, true>; }, Record<never, never> & Record<"by_threadId_startedAt", readonly ["threadId", "startedAt"]> & Record<"by_threadId_state", readonly ["threadId", "state"]> & Record<"by_threadId_state_startedAt", readonly ["threadId", "state", "startedAt"]> & Record<"by_state", readonly ["state"]> & Record<"by_messageId", readonly ["messageId"]> & Record<"by_replyId", readonly ["replyId"]>>; steps: import("@tokamak/sdk").TableDefinition<{ turnId: import("@tokamak/sdk").Validator<import("@tokamak/sdk").Id<"turns">, false>; n: import("@tokamak/sdk").Validator<number, false>; key: import("@tokamak/sdk").Validator<string, false>; type: import("@tokamak/sdk").Validator<"tool" | "helper", false>; kind: import("@tokamak/sdk").Validator<"command" | "read" | "edit" | "search" | "web" | "other", true>; name: import("@tokamak/sdk").Validator<string, true>; title: import("@tokamak/sdk").Validator<string, false>; detail: import("@tokamak/sdk").Validator<string, true>; text: import("@tokamak/sdk").Validator<string, true>; state: import("@tokamak/sdk").Validator<"running" | "done" | "failed", false>; startedAt: import("@tokamak/sdk").Validator<number, false>; finishedAt: import("@tokamak/sdk").Validator<number, true>; }, Record<never, never> & Record<"by_turnId_n", readonly ["turnId", "n"]> & Record<"by_turnId_type_n", readonly ["turnId", "type", "n"]> & Record<"by_turnId_key", readonly ["turnId", "key"]>>; signs: import("@tokamak/sdk").TableDefinition<{ turnId: import("@tokamak/sdk").Validator<import("@tokamak/sdk").Id<"turns">, false>; at: import("@tokamak/sdk").Validator<number, false>; }, Record<never, never> & Record<"by_turnId", readonly ["turnId"]>>; sweeps: import("@tokamak/sdk").TableDefinition<{ at: import("@tokamak/sdk").Validator<number, false>; since: import("@tokamak/sdk").Validator<number, false>; }, Record<never, never>>; }>>, "steps">; readonly index: () => number } }>, object>;
type Props24 = Extract<NonNullable<{ step: import("../lib/replies").Step; now: number }>, object>;
type Props25 = Extract<NonNullable<{ step: import("../lib/replies").Step }>, object>;
type Props26 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient; helper: import("../lib/replies").Helper; agentId: string }>, object>;
type Props27 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient; stepId: import("../lib/replies").Helper["_id"] }>, object>;
type Props28 = Extract<NonNullable<{ size?: 12 | 16 }>, object>;
type Props29 = Extract<NonNullable<import("plugin:chat/client").ThreadRowProps>, object>;
type Props30 = Extract<NonNullable<Props29 & { readonly $row: { readonly item: { readonly id: string; readonly name: string; readonly title: string; readonly state: "running" | "done" | "failed"; }; readonly index: () => number } }>, object>;
type Props31 = Extract<NonNullable<Props11 & { readonly $row: { readonly item: () => import("../lib/steers").BodyPiece; readonly index: number } }>, object>;
type Props32 = Extract<NonNullable<{ text: string; sender: string }>, object>;
export declare const parts: {
  readonly "AgentMark": {
    readonly "svg": import("@tokamak/sdk/client").ComponentPart<"ai.AgentMark.svg", Props1> & {
      readonly "path": import("@tokamak/sdk/client").ComponentPart<"ai.AgentMark.svg.path", Props2>;
    };
  };
  readonly "AgentRow": {
    readonly "Row": import("@tokamak/sdk/client").ComponentPart<"ai.AgentRow.Row", Props3>;
    readonly "OpenThreadRow": import("@tokamak/sdk/client").ComponentPart<"ai.AgentRow.OpenThreadRow", Props3>;
  };
  readonly "OpenThreadRow": {
    readonly "Row": import("@tokamak/sdk/client").ComponentPart<"ai.OpenThreadRow.Row", Props4>;
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.OpenThreadRow.div", Props4> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.OpenThreadRow.div.span", Props4>;
    };
  };
  readonly "Row": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.Row.div", Props5> & {
      readonly "Picker": import("@tokamak/sdk/client").ComponentPart<"ai.Row.div.Picker", Props5> & {
        readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.Row.div.Picker.AgentMark", Props5>;
      };
      readonly "Choosers": import("@tokamak/sdk/client").ComponentPart<"ai.Row.div.Choosers", Props5>;
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Row.div.span", Props5>;
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.Row.div.span$2", Props5>;
    };
  };
  readonly "Choosers": {
    readonly "Picker": import("@tokamak/sdk/client").ComponentPart<"ai.Choosers.Picker", Props7>;
    readonly "Picker$2": import("@tokamak/sdk/client").ComponentPart<"ai.Choosers.Picker$2", Props6>;
  };
  readonly "Picker": {
    readonly "value": {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Picker.value.span", Props8>;
    };
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Picker.span", Props8> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Picker.span.span", Props8>;
    };
    readonly "Menu$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai.Picker.Menu$2e$Root", Props8> & {
      readonly "Menu$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai.Picker.Menu$2e$Root.Menu$2e$Trigger", Props8>;
      readonly "Menu$2e$Content": import("@tokamak/sdk/client").ComponentPart<"ai.Picker.Menu$2e$Root.Menu$2e$Content", Props8> & {
        readonly "Menu$2e$Item": import("@tokamak/sdk/client").ComponentPart<"ai.Picker.Menu$2e$Root.Menu$2e$Content.Menu$2e$Item", Props9>;
      };
    };
  };
  readonly "AgentHeading": {
    readonly "h2": import("@tokamak/sdk/client").ComponentPart<"ai.AgentHeading.h2", {}>;
  };
  readonly "PermissionCard": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div", Props3> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div", Props3> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div.Icon", Props3>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div.span", Props3>;
        readonly "code": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div.code", Props3>;
      };
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.span", Props3>;
      readonly "div$2": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div$2", Props3> & {
        readonly "Tooltip$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div$2.Tooltip$2e$Root", Props10> & {
          readonly "Tooltip$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div$2.Tooltip$2e$Root.Tooltip$2e$Trigger", Props10>;
          readonly "Tooltip$2e$Content": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div$2.Tooltip$2e$Root.Tooltip$2e$Content", Props10> & {
            readonly "Kbd": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.div.div$2.Tooltip$2e$Root.Tooltip$2e$Content.Kbd", Props10>;
          };
        };
      };
    };
  };
  readonly "ReplyCards": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyCards.div", Props11> & {
      readonly "TasksCard": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyCards.div.TasksCard", Props11>;
      readonly "PlanCard": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyCards.div.PlanCard", Props11>;
      readonly "Usage": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyCards.div.Usage", Props11>;
    };
  };
  readonly "TasksCard": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section", Props12> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.div", Props12> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.div.span", Props12> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.div.span.Icon", Props12>;
        };
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.div.span$2", Props12>;
      };
      readonly "ul": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.ul", Props12> & {
        readonly "TaskRow": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.ul.TaskRow", Props13>;
      };
    };
  };
  readonly "TaskRow": {
    readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li", Props14> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li.span", Props14> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li.span.Icon", Props14>;
        readonly "Spinning": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li.span.Spinning", Props14>;
      };
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li.span$2", Props14>;
    };
  };
  readonly "PlanCard": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section", Props15> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section.div", Props15> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section.div.span", Props15> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section.div.span.Icon", Props15>;
        };
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section.div.span$2", Props15>;
      };
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section.p", Props15>;
    };
  };
  readonly "Usage": {
    readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai.Usage.p", Props16>;
  };
  readonly "ReplyHeader": {
    readonly "header": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyHeader.header", Props11> & {
      readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyHeader.header.AgentMark", Props11>;
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyHeader.header.span", Props11>;
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyHeader.header.span$2", Props11>;
    };
  };
  readonly "ReplyWork": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyWork.div", Props11> & {
      readonly "Thinking": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyWork.div.Thinking", Props11>;
      readonly "ActionsLine": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyWork.div.ActionsLine", Props11>;
      readonly "HelperRow": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyWork.div.HelperRow", Props17>;
    };
  };
  readonly "Folded": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.Folded.div", Props18> & {
      readonly "Collapsible$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai.Folded.div.Collapsible$2e$Root", Props18>;
    };
  };
  readonly "FoldedText": {
    readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai.FoldedText.p", Props19>;
  };
  readonly "Thinking": {
    readonly "Collapsible$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root", Props20> & {
      readonly "Collapsible$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root.Collapsible$2e$Trigger", Props20> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root.Collapsible$2e$Trigger.Icon", Props20>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root.Collapsible$2e$Trigger.span", Props20>;
      };
      readonly "Collapsible$2e$Panel": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root.Collapsible$2e$Panel", Props20> & {
        readonly "ThinkingText": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root.Collapsible$2e$Panel.ThinkingText", Props20>;
      };
    };
  };
  readonly "ThinkingText": {
    readonly "FoldedText": import("@tokamak/sdk/client").ComponentPart<"ai.ThinkingText.FoldedText", Props20>;
  };
  readonly "ActionsLine": {
    readonly "Folded": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded", Props21> & {
      readonly "Collapsible$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Trigger", Props21> & {
        readonly "Spinning": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Trigger.Spinning", Props21>;
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Trigger.Icon", Props21>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Trigger.span", Props21>;
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Trigger.span$2", Props21>;
        readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Trigger.span$3", Props21>;
        readonly "span$4": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Trigger.span$4", Props21>;
      };
      readonly "Collapsible$2e$Panel": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Panel", Props21> & {
        readonly "Steps": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Folded.Collapsible$2e$Panel.Steps", Props21>;
      };
    };
  };
  readonly "Steps": {
    readonly "ul": import("@tokamak/sdk/client").ComponentPart<"ai.Steps.ul", Props22> & {
      readonly "StepRow": import("@tokamak/sdk/client").ComponentPart<"ai.Steps.ul.StepRow", Props23>;
    };
  };
  readonly "StepRow": {
    readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai.StepRow.li", Props24> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.StepRow.li.span", Props24> & {
        readonly "StepIcon": import("@tokamak/sdk/client").ComponentPart<"ai.StepRow.li.span.StepIcon", Props24>;
      };
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.StepRow.li.span$2", Props24>;
      readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"ai.StepRow.li.span$3", Props24>;
    };
  };
  readonly "StepIcon": {
    readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"ai.StepIcon.StatusIcon", Props25>;
    readonly "StatusIcon$2": import("@tokamak/sdk/client").ComponentPart<"ai.StepIcon.StatusIcon$2", Props25>;
    readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.StepIcon.Icon", Props25>;
  };
  readonly "HelperRow": {
    readonly "Folded": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded", Props26> & {
      readonly "Collapsible$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger", Props26> & {
        readonly "Spinning": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger.Spinning", Props26>;
        readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger.StatusIcon", Props26>;
        readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger.AgentMark", Props26>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger.span", Props26>;
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger.span$2", Props26>;
      };
      readonly "Collapsible$2e$Panel": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Panel", Props26> & {
        readonly "FoldedText": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Panel.FoldedText", Props26>;
        readonly "HelperText": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Panel.HelperText", Props26>;
      };
    };
  };
  readonly "HelperText": {
    readonly "FoldedText": import("@tokamak/sdk/client").ComponentPart<"ai.HelperText.FoldedText", Props27>;
  };
  readonly "Spinning": {
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Spinning.span", Props28> & {
      readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"ai.Spinning.span.StatusIcon", Props28>;
    };
  };
  readonly "ThreadStatusIcon": {
    readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadStatusIcon.StatusIcon", Props29>;
  };
  readonly "ThreadDetail": {
    readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadDetail.AgentMark", Props29>;
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadDetail.span", Props29>;
    readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadDetail.span$2", Props29>;
  };
  readonly "ThreadHelpers": {
    readonly "ul": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul", Props29> & {
      readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.li", Props30> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.li.span", Props30> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.li.span.span", Props30> & {
            readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.li.span.span.AgentMark", Props30>;
          };
          readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.li.span.span$2", Props30>;
          readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.li.span.span$3", Props30>;
          readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.li.span.StatusIcon", Props30>;
        };
      };
    };
  };
  readonly "StopButton": {
    readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai.StopButton.Button", Props3>;
    readonly "Button$2": import("@tokamak/sdk/client").ComponentPart<"ai.StopButton.Button$2", Props3>;
  };
  readonly "SteeredBody": {
    readonly "body": import("@tokamak/sdk/client").ComponentPart<"ai.SteeredBody.body", Props11> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.SteeredBody.body.div", Props31>;
      readonly "Steer": import("@tokamak/sdk/client").ComponentPart<"ai.SteeredBody.body.Steer", Props31>;
    };
  };
  readonly "Steer": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div", Props32> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.span", Props32> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.span.Icon", Props32>;
      };
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.span$2", Props32> & {
        readonly "Avatar": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.span$2.Avatar", Props32>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.span$2.span", Props32>;
      };
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.p", Props32>;
    };
  };
};
