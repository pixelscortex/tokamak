import type { Command } from "../command";
import { memberRequest } from "../server";

export default {
  usesServer: true,
  path: "invite",
  summary: "Create a personal invite for a new member.",
  args: { name: "name" },
  example: "tokamak invite Alice --json",
  async run([name], { server }) {
    const { body, origin } = await memberRequest("invite", "/members", server, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const { token, local } = body as { token: string; local?: boolean };
    const invite = local ? token : `${origin}/join#${token}`;
    return { data: { invite }, text: invite, jsonText: "Invite created." };
  },
} satisfies Command;
