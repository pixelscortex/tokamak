import type { Accessor, Setter } from "solid-js";
import type { NativeEvent } from "@tokamak/render";
import type { ChatState } from "./use-chat";
import type { useDrafts } from "./use-drafts";
import type { useMap } from "./use-map";

type Controls = {
  chat: ChatState;
  composer: ReturnType<typeof useDrafts>;
  map: ReturnType<typeof useMap>;
  mapOpen: Accessor<boolean>;
  setMapOpen: Setter<boolean>;
  closeMap: () => void;
  newThread: () => Promise<void>;
  pickerOpen: Accessor<boolean>;
  setPickerOpen: Setter<boolean>;
  pickerKey: (event: NativeEvent) => void;
  closePicker: () => void;
  shareOpen: Accessor<boolean>;
  setShareOpen: Setter<boolean>;
  shareKey: (event: NativeEvent) => void;
  closeShare: () => void;
  pickPermission: (index: number) => boolean;
  copyReply: () => void;
};

export function chatKeys(controls: Controls) {
  return (event: NativeEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    const key = event.key ?? "";
    if (shortcut(controls, event, key)) return;
    if (controls.pickerOpen()) {
      controls.pickerKey(event);
      return;
    }
    if (controls.shareOpen()) {
      controls.shareKey(event);
      return;
    }
    if (controls.mapOpen() && controls.map.editing()) {
      controls.map.keydown(event);
      return;
    }
    if (togglesMap(key, controls.mapOpen())) {
      event.preventDefault();
      if (event.repeat) return;
      if (controls.mapOpen()) controls.closeMap();
      else {
        controls.map.reset();
        controls.setMapOpen(true);
      }
      return;
    }
    if (controls.mapOpen()) {
      controls.map.keydown(event);
      return;
    }
    if (answerPermission(controls, event, key)) return;
    stopRun(controls.chat, event);
  };
}

function answerPermission(controls: Controls, event: NativeEvent, key: string) {
  if (!controls.chat.isOwner() || controls.composer.draft() || !/^[1-4]$/.test(key)) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return false;
  if (!controls.pickPermission(Number(key) - 1)) return false;
  event.preventDefault();
  return true;
}

function stopRun(chat: ChatState, event: NativeEvent) {
  if (event.key !== "Escape" || !chat.canStop()) return;
  event.preventDefault();
  if (!event.repeat) void chat.cancel();
}

function shortcut(controls: Controls, event: NativeEvent, key: string) {
  const letter = key.toLowerCase();
  if (controls.chat.isOwner() && event.metaKey && (letter === "n" || key === "Enter")) {
    event.preventDefault();
    if (!event.repeat) void controls.newThread();
    return true;
  }
  if (controls.mapOpen() || !event.metaKey) return false;
  if (event.shiftKey && letter === "c") {
    event.preventDefault();
    if (!event.repeat) controls.copyReply();
    return true;
  }
  return pickerShortcut(controls, event, letter);
}

function pickerShortcut(controls: Controls, event: NativeEvent, letter: string) {
  if (!controls.chat.isOwner()) return false;
  if (event.shiftKey && letter === "s") {
    event.preventDefault();
    if (!event.repeat) {
      controls.closePicker();
      controls.setShareOpen((open) => !open);
    }
    return true;
  }
  if (letter !== "m") return false;
  event.preventDefault();
  if (!event.repeat) {
    controls.closeShare();
    controls.setPickerOpen((open) => !open);
  }
  return true;
}

function togglesMap(key: string, open: boolean) {
  return key === "Tab" || (key === "Escape" && open);
}
