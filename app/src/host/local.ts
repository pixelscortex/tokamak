import { Channel, invoke } from "@tauri-apps/api/core";
import type { JsonValue } from "@tokamak/sdk";
import type { LaunchLocalWorker } from "../../../packages/runtime/js/local";

type WorkerEvent = { type: "message"; message: JsonValue } | { type: "closed"; reason: string };

export const launchLocalWorker: LaunchLocalWorker = async (artifact, receive, closed) => {
  const events = new Channel<WorkerEvent>();
  events.onmessage = (event) => {
    if (event.type === "message") receive(event.message);
    else closed(event.reason);
  };
  const id = await invoke<string>("local_worker_start", {
    plugin: artifact.id,
    entryHash: artifact.entryHash,
    codeHash: artifact.codeHash,
    events,
  });
  return {
    send: (message) => invoke("local_worker_write", { id, message }),
    load: (provider) =>
      invoke<string>("local_worker_load", {
        id,
        plugin: provider.id,
        entryHash: provider.entryHash,
        codeHash: provider.codeHash,
      }),
    close: () => invoke("local_worker_close", { id }),
  };
};
