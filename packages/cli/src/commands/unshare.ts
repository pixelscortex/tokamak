import { CommandError, type Command } from "../command";
import { sharingEndpoint, sharingRequest } from "../server";

const example = "tokamak plugin unshare my-plugin --server https://tokamak.example.com";

export default {
  path: "plugin unshare",
  usesServer: true,
  summary: "Remove a shared plugin from a selected server.",
  args: { name: "id" },
  example,
  async run([id], { server }) {
    const endpoint = sharingEndpoint(server, example);
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(id!))
      throw new CommandError(
        `Plugin not found: ${id}`,
        `tokamak plugin list --server ${endpoint.url.origin}`,
      );
    const data = (await sharingRequest(`/plugins/${encodeURIComponent(id!)}`, endpoint, {
      method: "DELETE",
    })) as { id: string; removed: boolean; reverted?: boolean; buildId?: string };
    return {
      data,
      text: data.reverted ? `Reverted ${data.id} to build id ${data.buildId}` : `Removed ${data.id}`,
    };
  },
} satisfies Command;
