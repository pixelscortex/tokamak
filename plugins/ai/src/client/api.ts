/**
 * ai's window entry: it extends chat through the elements chat publishes and
 * imports no agent plugin. Agents reach `ai` only through `plugin:ai/contracts`.
 */
import { after, append, before, prepend, replace } from "@tokamak/sdk/client";
import * as chat from "plugin:chat/client";
import { AgentRow } from "./ui/agent-row";
import { SteeredBody } from "./ui/turn-steers";
import { hasSteers } from "./lib/steers";
import { StopButton } from "./ui/turn-controls";
import { AgentHeading } from "./ui/heading";
import { ReplyCards } from "./ui/reply-cards";
import { ReplyHeader } from "./ui/reply-header";
import { ReplyWork } from "./ui/reply-work";
import { isAgentReply, shownTurn } from "./lib/replies";
import { PermissionCard } from "./ui/permission-card";
import { activeFor } from "./lib/turn-controls";
import { listenForSends } from "./lib/turn";
import { questionFor } from "./lib/questions";
import { isWorking, statusOf } from "./lib/thread-status";
import { ThreadDetail, ThreadHelpers, ThreadStatusIcon } from "./ui/thread-status";

listenForSends();

/** The agent row sits under the composer box, inside the composer's tray. */
export const Agent = after(chat.parts.Composer.div.div$2, AgentRow);
/** "What should Claude work on?" in place of "Start a conversation". */
export const Heading = replace(chat.parts.Empty.div.div.h2, AgentHeading);
/** The permission question, on the composer's tray above the prompt, while the sender's turn waits. */
export const Permission = prepend(chat.parts.Composer.div.div, PermissionCard, {
  when: (composer) => questionFor(composer.threadId) !== undefined,
});

/** An agent's reply: "✳ Claude  opus 5.5" in place of chat's author line. */
export const ReplyAuthor = replace(chat.parts.Message.article.header, ReplyHeader, { when: isAgentReply });
/** Above the reply's text: thinking, the actions line and helper rows. */
export const Work = before(chat.parts.Message.article.div, ReplyWork, { when: isAgentReply });
/** Under the reply's text: Tasks, the plan card and usage. */
export const Cards = after(chat.parts.Message.article.div, ReplyCards, { when: isAgentReply });
export const Stop = replace(chat.parts.Composer.div.div$2.div.SendButton, StopButton, {
  when: (props) => Boolean(activeFor(props.threadId)),
});

/**
 * A reply the person steered: its text cut where each follow-up arrived, the
 * follow-up drawn between as their own message. Other replies keep chat's body.
 */
export const Steers = replace(chat.parts.Message.article.div, SteeredBody, {
  when: (props) => isAgentReply(props) && hasSteers(shownTurn(props)),
});

/** The status icon before each thread's title in chat's list. */
export const ThreadStatus = prepend(chat.parts.ThreadRow.ListboxItem.span.span.span, ThreadStatusIcon);
/** The second line (agent, model, folder), only while the thread's turn runs or waits. */
export const ThreadWork = append(chat.parts.ThreadRow.ListboxItem.span.span$2, ThreadDetail, {
  when: (row) => isWorking(statusOf(row.thread._id)),
});
/** The working turn's helper agents, as small rows under the thread. */
export const Helpers = after(chat.parts.ThreadRow.ListboxItem.span.span$2, ThreadHelpers, {
  when: (row) => isWorking(statusOf(row.thread._id)) && (statusOf(row.thread._id)?.helpers.length ?? 0) > 0,
});
