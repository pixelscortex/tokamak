import { contract } from "@tokamak/sdk";

export const callLoop = contract<{ next(): Promise<null> }>("callLoop");

export const actionLoop = contract<{ next(): Promise<null> }>("actionLoop");
