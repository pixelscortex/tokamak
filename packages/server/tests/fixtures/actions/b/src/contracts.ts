import { contract } from "@tokamak/sdk";

export const callLoop = contract<{ next(): Promise<null> }>("callLoop");
