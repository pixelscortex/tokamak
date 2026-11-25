import { contract } from "@tokamak/sdk";

export const directory = contract<{
  list: (args: { text: string }) => Promise<{ name: string; detail: string }[]>;
}>("directory");
