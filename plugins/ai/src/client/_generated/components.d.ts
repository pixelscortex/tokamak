// Generated plugin screen paths. Commit this file.
export * from "../api";
type Props1 = Extract<NonNullable<{
  agentId: string | undefined;
  modelId?: string | undefined;
  size?: 12 | 14 | 16;
  label?: string;
  class?: string;
}>, object>;
type Props2 = Extract<NonNullable<import("plugin:chat/client").ComposerProps>, object>;
type Props3 = Extract<NonNullable<{
  client: import("@tokamak/sdk").TokamakClient;
  threadId: string;
  turnLine: () => string | undefined;
}>, object>;
type Props4 = Extract<NonNullable<{
  client: import("@tokamak/sdk").TokamakClient;
  threadId: string | undefined;
  resolved: () => import("../lib/choices").Resolved | undefined;
  turnLine: () => string | undefined;
}>, object>;
type Props5 = Extract<NonNullable<{
  current: import("../lib/choices").Resolved;
  refresh: (open: boolean) => void;
  change: (current: import("../lib/choices").Resolved, next: import("../lib/choices").Change) => void;
}>, object>;
type Props6 = Extract<NonNullable<{
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
type Props7 = Extract<NonNullable<import("plugin:chat/client").MessageProps>, object>;
type Props8 = Extract<NonNullable<{ tasks: readonly import("@tokamak/sdk/agent-turn").Task[] }>, object>;
type Props9 = Extract<NonNullable<{ task: import("@tokamak/sdk/agent-turn").Task }>, object>;
type Props10 = Extract<NonNullable<{ text: string }>, object>;
type Props11 = Extract<NonNullable<{ turn: import("solid-js").Accessor<import("../lib/replies").Turn> }>, object>;
type Props12 = Extract<NonNullable<{ children: import("@solidjs/web").JSX.Element }>, object>;
type Props13 = Extract<NonNullable<{ text: string | null | undefined }>, object>;
type Props14 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient; turnId: import("../lib/replies").Turn["_id"] }>, object>;
type Props15 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient; turn: import("solid-js").Accessor<import("../lib/replies").Turn> }>, object>;
type Props16 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient; turnId: import("../lib/replies").Turn["_id"]; now: number }>, object>;
type Props17 = Extract<NonNullable<{ step: import("../lib/replies").Step; now: number }>, object>;
type Props18 = Extract<NonNullable<{ step: import("../lib/replies").Step }>, object>;
type Props19 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient; helper: import("../lib/replies").Helper; agentId: string }>, object>;
type Props20 = Extract<NonNullable<{ client: import("@tokamak/sdk").TokamakClient; stepId: import("../lib/replies").Helper["_id"] }>, object>;
type Props21 = Extract<NonNullable<{ size?: 12 | 16 }>, object>;
type Props22 = Extract<NonNullable<import("plugin:chat/client").ThreadRowProps>, object>;
type Props23 = Extract<NonNullable<{ text: string; sender: string }>, object>;
export declare const parts: {
  readonly "AgentMark": {
    readonly "svg": import("@tokamak/sdk/client").ComponentPart<"ai.AgentMark.svg", Props1> & {
      readonly "For": import("@tokamak/sdk/client").ComponentPart<"ai.AgentMark.svg.For", Props1> & {
        readonly "path": import("@tokamak/sdk/client").ComponentPart<"ai.AgentMark.svg.For.path", Props1>;
      };
    };
  };
  readonly "AgentRow": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.AgentRow.Show", Props2> & {
      readonly "Row": import("@tokamak/sdk/client").ComponentPart<"ai.AgentRow.Show.Row", Props2>;
      readonly "OpenThreadRow": import("@tokamak/sdk/client").ComponentPart<"ai.AgentRow.Show.OpenThreadRow", Props2>;
    };
  };
  readonly "OpenThreadRow": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.OpenThreadRow.Show", Props3> & {
      readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.OpenThreadRow.Show.Show", Props3> & {
        readonly "Row": import("@tokamak/sdk/client").ComponentPart<"ai.OpenThreadRow.Show.Show.Row", Props3>;
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.OpenThreadRow.Show.Show.div", Props3> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.OpenThreadRow.Show.Show.div.span", Props3>;
        };
      };
    };
  };
  readonly "Row": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.Row.Show", Props4> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.Row.Show.div", Props4> & {
        readonly "Picker": import("@tokamak/sdk/client").ComponentPart<"ai.Row.Show.div.Picker", Props4> & {
          readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.Row.Show.div.Picker.AgentMark", Props4>;
        };
        readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.Row.Show.div.Show", Props4> & {
          readonly "Choosers": import("@tokamak/sdk/client").ComponentPart<"ai.Row.Show.div.Show.Choosers", Props4>;
        };
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Row.Show.div.span", Props4>;
        readonly "Show$2": import("@tokamak/sdk/client").ComponentPart<"ai.Row.Show.div.Show$2", Props4> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Row.Show.div.Show$2.span", Props4>;
        };
      };
    };
  };
  readonly "Choosers": {
    readonly "For": import("@tokamak/sdk/client").ComponentPart<"ai.Choosers.For", Props5> & {
      readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.Choosers.For.Show", Props5> & {
        readonly "Picker": import("@tokamak/sdk/client").ComponentPart<"ai.Choosers.For.Show.Picker", Props5>;
      };
    };
    readonly "Picker": import("@tokamak/sdk/client").ComponentPart<"ai.Choosers.Picker", Props5>;
  };
  readonly "value": {
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.value.span", {}>;
  };
  readonly "Picker": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.Picker.Show", Props6> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Picker.Show.span", Props6> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Picker.Show.span.span", Props6>;
      };
      readonly "Menu$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai.Picker.Show.Menu$2e$Root", Props6> & {
        readonly "Menu$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai.Picker.Show.Menu$2e$Root.Menu$2e$Trigger", Props6>;
        readonly "Menu$2e$Content": import("@tokamak/sdk/client").ComponentPart<"ai.Picker.Show.Menu$2e$Root.Menu$2e$Content", Props6> & {
          readonly "For": import("@tokamak/sdk/client").ComponentPart<"ai.Picker.Show.Menu$2e$Root.Menu$2e$Content.For", Props6> & {
            readonly "Menu$2e$Item": import("@tokamak/sdk/client").ComponentPart<"ai.Picker.Show.Menu$2e$Root.Menu$2e$Content.For.Menu$2e$Item", Props6>;
          };
        };
      };
    };
  };
  readonly "AgentHeading": {
    readonly "h2": import("@tokamak/sdk/client").ComponentPart<"ai.AgentHeading.h2", {}>;
  };
  readonly "PermissionCard": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.Show", Props2> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.Show.div", Props2> & {
        readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.Show.div.div", Props2> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.Show.div.div.Icon", Props2>;
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.Show.div.div.span", Props2>;
          readonly "code": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.Show.div.div.code", Props2>;
        };
        readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.Show.div.Show", Props2> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.Show.div.Show.span", Props2>;
          readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.Show.div.Show.div", Props2> & {
            readonly "For": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.Show.div.Show.div.For", Props2> & {
              readonly "Tooltip$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.Show.div.Show.div.For.Tooltip$2e$Root", Props2> & {
                readonly "Tooltip$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.Show.div.Show.div.For.Tooltip$2e$Root.Tooltip$2e$Trigger", Props2>;
                readonly "Tooltip$2e$Content": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.Show.div.Show.div.For.Tooltip$2e$Root.Tooltip$2e$Content", Props2> & {
                  readonly "Kbd": import("@tokamak/sdk/client").ComponentPart<"ai.PermissionCard.Show.div.Show.div.For.Tooltip$2e$Root.Tooltip$2e$Content.Kbd", Props2>;
                };
              };
            };
          };
        };
      };
    };
  };
  readonly "ReplyCards": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyCards.Show", Props7> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyCards.Show.div", Props7> & {
        readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyCards.Show.div.Show", Props7> & {
          readonly "TasksCard": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyCards.Show.div.Show.TasksCard", Props7>;
        };
        readonly "Show$2": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyCards.Show.div.Show$2", Props7> & {
          readonly "PlanCard": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyCards.Show.div.Show$2.PlanCard", Props7>;
        };
        readonly "Usage": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyCards.Show.div.Usage", Props7>;
      };
    };
  };
  readonly "TasksCard": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section", Props8> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.div", Props8> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.div.span", Props8> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.div.span.Icon", Props8>;
        };
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.div.span$2", Props8>;
      };
      readonly "ul": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.ul", Props8> & {
        readonly "For": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.ul.For", Props8> & {
          readonly "TaskRow": import("@tokamak/sdk/client").ComponentPart<"ai.TasksCard.section.ul.For.TaskRow", Props8>;
        };
      };
    };
  };
  readonly "TaskRow": {
    readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li", Props9> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li.span", Props9> & {
        readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li.span.Show", Props9> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li.span.Show.Icon", Props9>;
          readonly "Spinning": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li.span.Show.Spinning", Props9>;
        };
      };
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.TaskRow.li.span$2", Props9>;
    };
  };
  readonly "PlanCard": {
    readonly "section": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section", Props10> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section.div", Props10> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section.div.span", Props10> & {
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section.div.span.Icon", Props10>;
        };
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section.div.span$2", Props10>;
      };
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai.PlanCard.section.p", Props10>;
    };
  };
  readonly "Usage": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.Usage.Show", Props11> & {
      readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai.Usage.Show.p", Props11>;
    };
  };
  readonly "ReplyHeader": {
    readonly "header": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyHeader.header", Props7> & {
      readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyHeader.header.AgentMark", Props7>;
      readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyHeader.header.Show", Props7> & {
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyHeader.header.Show.span", Props7>;
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyHeader.header.Show.span$2", Props7>;
      };
    };
  };
  readonly "ReplyWork": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyWork.Show", Props7> & {
      readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyWork.Show.div", Props7> & {
        readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyWork.Show.div.Show", Props7> & {
          readonly "Thinking": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyWork.Show.div.Show.Thinking", Props7>;
        };
        readonly "ActionsLine": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyWork.Show.div.ActionsLine", Props7>;
        readonly "For": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyWork.Show.div.For", Props7> & {
          readonly "HelperRow": import("@tokamak/sdk/client").ComponentPart<"ai.ReplyWork.Show.div.For.HelperRow", Props7>;
        };
      };
    };
  };
  readonly "Folded": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.Folded.div", Props12> & {
      readonly "Collapsible$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai.Folded.div.Collapsible$2e$Root", Props12>;
    };
  };
  readonly "FoldedText": {
    readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai.FoldedText.p", Props13>;
  };
  readonly "Thinking": {
    readonly "Collapsible$2e$Root": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root", Props14> & {
      readonly "Collapsible$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root.Collapsible$2e$Trigger", Props14> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root.Collapsible$2e$Trigger.Icon", Props14>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root.Collapsible$2e$Trigger.span", Props14>;
      };
      readonly "Collapsible$2e$Panel": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root.Collapsible$2e$Panel", Props14> & {
        readonly "ThinkingText": import("@tokamak/sdk/client").ComponentPart<"ai.Thinking.Collapsible$2e$Root.Collapsible$2e$Panel.ThinkingText", Props14>;
      };
    };
  };
  readonly "ThinkingText": {
    readonly "FoldedText": import("@tokamak/sdk/client").ComponentPart<"ai.ThinkingText.FoldedText", Props14>;
  };
  readonly "ActionsLine": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Show", Props15> & {
      readonly "Folded": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Show.Folded", Props15> & {
        readonly "Collapsible$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Show.Folded.Collapsible$2e$Trigger", Props15> & {
          readonly "Spinning": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Show.Folded.Collapsible$2e$Trigger.Spinning", Props15>;
          readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Show.Folded.Collapsible$2e$Trigger.Icon", Props15>;
          readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Show.Folded.Collapsible$2e$Trigger.Show", Props15>;
          readonly "Show$2": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Show.Folded.Collapsible$2e$Trigger.Show$2", Props15> & {
            readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Show.Folded.Collapsible$2e$Trigger.Show$2.span", Props15>;
            readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Show.Folded.Collapsible$2e$Trigger.Show$2.span$2", Props15>;
            readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Show.Folded.Collapsible$2e$Trigger.Show$2.span$3", Props15>;
            readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Show.Folded.Collapsible$2e$Trigger.Show$2.Show", Props15> & {
              readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Show.Folded.Collapsible$2e$Trigger.Show$2.Show.span", Props15>;
            };
          };
        };
        readonly "Collapsible$2e$Panel": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Show.Folded.Collapsible$2e$Panel", Props15> & {
          readonly "Steps": import("@tokamak/sdk/client").ComponentPart<"ai.ActionsLine.Show.Folded.Collapsible$2e$Panel.Steps", Props15>;
        };
      };
    };
  };
  readonly "Steps": {
    readonly "ul": import("@tokamak/sdk/client").ComponentPart<"ai.Steps.ul", Props16> & {
      readonly "For": import("@tokamak/sdk/client").ComponentPart<"ai.Steps.ul.For", Props16> & {
        readonly "StepRow": import("@tokamak/sdk/client").ComponentPart<"ai.Steps.ul.For.StepRow", Props16>;
      };
    };
  };
  readonly "StepRow": {
    readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai.StepRow.li", Props17> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.StepRow.li.span", Props17> & {
        readonly "StepIcon": import("@tokamak/sdk/client").ComponentPart<"ai.StepRow.li.span.StepIcon", Props17>;
      };
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.StepRow.li.span$2", Props17>;
      readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"ai.StepRow.li.span$3", Props17>;
    };
  };
  readonly "StepIcon": {
    readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"ai.StepIcon.StatusIcon", Props18>;
    readonly "StatusIcon$2": import("@tokamak/sdk/client").ComponentPart<"ai.StepIcon.StatusIcon$2", Props18>;
    readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.StepIcon.Icon", Props18>;
  };
  readonly "HelperRow": {
    readonly "Folded": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded", Props19> & {
      readonly "Collapsible$2e$Trigger": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger", Props19> & {
        readonly "Spinning": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger.Spinning", Props19>;
        readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger.StatusIcon", Props19>;
        readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger.AgentMark", Props19>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger.span", Props19>;
        readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Trigger.span$2", Props19>;
      };
      readonly "Collapsible$2e$Panel": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Panel", Props19> & {
        readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Panel.Show", Props19> & {
          readonly "FoldedText": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Panel.Show.FoldedText", Props19>;
          readonly "HelperText": import("@tokamak/sdk/client").ComponentPart<"ai.HelperRow.Folded.Collapsible$2e$Panel.Show.HelperText", Props19>;
        };
      };
    };
  };
  readonly "HelperText": {
    readonly "FoldedText": import("@tokamak/sdk/client").ComponentPart<"ai.HelperText.FoldedText", Props20>;
  };
  readonly "Spinning": {
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Spinning.span", Props21> & {
      readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"ai.Spinning.span.StatusIcon", Props21>;
    };
  };
  readonly "ThreadStatusIcon": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadStatusIcon.Show", Props22> & {
      readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadStatusIcon.Show.StatusIcon", Props22>;
    };
  };
  readonly "ThreadDetail": {
    readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadDetail.AgentMark", Props22>;
    readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadDetail.span", Props22>;
    readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadDetail.span$2", Props22>;
  };
  readonly "ThreadHelpers": {
    readonly "ul": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul", Props22> & {
      readonly "For": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.For", Props22> & {
        readonly "li": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.For.li", Props22> & {
          readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.For.li.span", Props22> & {
            readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.For.li.span.span", Props22> & {
              readonly "AgentMark": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.For.li.span.span.AgentMark", Props22>;
            };
            readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.For.li.span.span$2", Props22>;
            readonly "span$3": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.For.li.span.span$3", Props22>;
            readonly "StatusIcon": import("@tokamak/sdk/client").ComponentPart<"ai.ThreadHelpers.ul.For.li.span.StatusIcon", Props22>;
          };
        };
      };
    };
  };
  readonly "StopButton": {
    readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.StopButton.Show", Props2> & {
      readonly "Button": import("@tokamak/sdk/client").ComponentPart<"ai.StopButton.Show.Button", Props2>;
      readonly "Button$2": import("@tokamak/sdk/client").ComponentPart<"ai.StopButton.Show.Button$2", Props2>;
    };
  };
  readonly "SteeredBody": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.SteeredBody.div", Props7> & {
      readonly "For": import("@tokamak/sdk/client").ComponentPart<"ai.SteeredBody.div.For", Props7> & {
        readonly "Switch": import("@tokamak/sdk/client").ComponentPart<"ai.SteeredBody.div.For.Switch", Props7> & {
          readonly "Match": import("@tokamak/sdk/client").ComponentPart<"ai.SteeredBody.div.For.Switch.Match", Props7> & {
            readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.SteeredBody.div.For.Switch.Match.div", Props7>;
          };
          readonly "Match$2": import("@tokamak/sdk/client").ComponentPart<"ai.SteeredBody.div.For.Switch.Match$2", Props7> & {
            readonly "Steer": import("@tokamak/sdk/client").ComponentPart<"ai.SteeredBody.div.For.Switch.Match$2.Steer", Props7>;
          };
        };
      };
    };
  };
  readonly "Steer": {
    readonly "div": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div", Props23> & {
      readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.span", Props23> & {
        readonly "Icon": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.span.Icon", Props23>;
      };
      readonly "span$2": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.span$2", Props23> & {
        readonly "Avatar": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.span$2.Avatar", Props23>;
        readonly "span": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.span$2.span", Props23>;
      };
      readonly "Show": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.Show", Props23> & {
        readonly "p": import("@tokamak/sdk/client").ComponentPart<"ai.Steer.div.Show.p", Props23>;
      };
    };
  };
};
