import { definePlugin } from "@tokamak/sdk";

export default definePlugin({
  id: "agent-proxy",
  version: "0.1.0",
  name: "Agent Proxy",
  permissions: [
    "env:TOKAMAK_AGENT_PROXY_ADDRESSES",
    "net:claude.ai",
    "net:platform.claude.com",
    "net:api.anthropic.com",
    "net:auth.openai.com",
    "net:chatgpt.com",
  ],
  description: "Provider accounts and model access for agent profiles.",
});
