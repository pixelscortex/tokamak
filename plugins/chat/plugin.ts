import { definePlugin } from "@tokamak/sdk";
export default definePlugin({
  id: "chat",
  maintenance: "machines:expire",
  version: "0.3.0",
  name: "Chat",
  description: "Threads, messages, and agent conversations.",
  depends: [],
  permissions: [],
});
