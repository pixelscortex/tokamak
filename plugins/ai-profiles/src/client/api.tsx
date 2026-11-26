/**
 * ai-profiles' window entry: the Profiles page. It reaches subscriptions only
 * through its own server functions, which pass on to `agent-proxy`.
 */
export { Profiles } from "./pages/profiles";

import { append } from "@tokamak/sdk/client";
import * as ai from "plugin:ai/client";
import * as chat from "plugin:chat/client";
import {
  IdleThreadProfile,
  PickerProfileColumn,
  PickerProfileChip,
  PickerProfileStatus,
  ThreadProfile,
} from "./ui/thread-profile";

export const ProfileColumn = append(ai.parts.PickerColumns.div.extraColumns, PickerProfileColumn);
export const ProfileChip = append(ai.parts.PickerChip.Menu$2e$Trigger.chipExtras, PickerProfileChip);
export const ProfileStatus = append(ai.parts.Row.div.statusExtras, PickerProfileStatus);
export const WorkingProfile = append(ai.parts.ThreadDetail.detailExtras, ThreadProfile);
export const IdleProfile = append(chat.parts.ThreadRow.ListboxItem.span.detail, IdleThreadProfile, {
  when: (row) => !ai.hasLiveThreadDetail(row.thread._id),
});
