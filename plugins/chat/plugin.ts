import { definePlugin } from "@tokamak/sdk";
export default definePlugin({
  id: "chat",
  maintenance: "runs:recover",
  version: "0.1.0",
  name: "Chat",
  description: "Threads, messages, and agent conversations.",
  depends: [],
  permissions: [],
});
