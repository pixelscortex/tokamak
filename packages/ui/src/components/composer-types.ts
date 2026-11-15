import type { JSX } from "@tokamak/render";
import type { SelectOption } from "./select";

/** A context chip: what the message is about (a task, a file). */
export interface ComposerContext {
  id: string;
  label: string;
  /** Where it comes from (a plugin, a folder). */
  detail?: string;
  /** Leading icon path data (24 px viewBox, stroked). */
  icon?: string;
}

/** The run in progress, for the status shelf. */
export interface ComposerRun {
  /** What the run is doing now. */
  step: string;
  /** 1-based number of the current step. */
  stepIndex: number;
  stepCount: number;
  /** Elapsed time, already formatted ("14s", "1:05"). */
  elapsed: string;
  /** A follow-up typed while running, sent when the run ends. */
  queued?: string;
  onCancelQueued?: () => void;
}

/** A command a plugin offers. */
export interface ComposerCommand {
  /** Without the slash: `todo`. */
  name: string;
  description: string;
  /** The plugin that offers it. */
  source: string;
}

/** One option select of a command form. */
export interface ComposerField {
  id: string;
  /** Accessible name (the select shows only the value). */
  label: string;
  options: readonly SelectOption[];
  value?: string;
  onChange?: (value: string) => void;
}

/** A picked command waiting for its title and options. */
export interface ComposerForm {
  /** The command's tag: `/todo`. */
  tag: string;
  /** Placeholder of the title (the composer's text). */
  placeholder?: string;
  fields?: readonly ComposerField[];
  /** The submit button's label (default "Create"). */
  submitLabel?: string;
  onSubmit: (title: string) => void;
  onCancel?: () => void;
}

/** A question the run asks before it goes on. */
export interface ComposerApproval {
  question: string;
  /** What is asked for, in the data font (`todo.write`). */
  detail?: string;
  onDeny: () => void;
  onAllowOnce: () => void;
  /** Shows "Always allow". */
  onAlwaysAllow?: () => void;
}

export interface ComposerProps {
  id?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  /** Enter or the send button, with the text (trimmed text is not empty).
   * The composer clears its text afterwards. */
  onSubmit?: (text: string) => void;
  /** Lines of text before it scrolls (default 8). */
  maxRows?: number;
  docked?: boolean;
  /** Classes of the outer shape (width). */
  class?: string;
  context?: readonly ComposerContext[];
  /** Chips shown before "+N more" (default 6). */
  contextLimit?: number;
  onRemoveContext?: (id: string) => void;
  models?: readonly SelectOption[];
  model?: string;
  onModelChange?: (value: string) => void;
  onAttach?: () => void;
  onMention?: () => void;
  running?: ComposerRun;
  onStop?: () => void;
  commands?: readonly ComposerCommand[];
  onCommand?: (command: ComposerCommand) => void;
  form?: ComposerForm;
  approval?: ComposerApproval;
  /** Free content above the text (below the states above). */
  above?: JSX.Element;
  /** Extra footer content, after attach and mention. */
  tools?: JSX.Element;
}
