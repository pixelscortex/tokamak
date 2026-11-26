import type {
  ActionContext,
  CallerActionContext,
  Failure,
  MachineId,
  MutationContext,
  QueryContext,
} from "./functions";
import { callHost } from "./host";
import { machineScope, type MachineScope } from "./internal/machine-scope";
import type { DataModel } from "./schema";

export interface MachineEntry {
  id: MachineId;
  name: string;
  owner: { kind: "plugin"; plugin: string } | { kind: "person"; user: string };
  online: boolean;
  lastSeen: number | null;
  member?: string;
}

interface MachineList {
  /** A snapshot; presence changes do not invalidate query subscriptions. */
  list(): Promise<MachineEntry[]>;
}

interface MachineManagement extends MachineList {
  create(options: { name: string; member?: string }): Promise<MachineCreation>;
  /** Available in a server action. Lists all machines owned by this plugin. */
  listAll(): Promise<MachineEntry[]>;
  remove(id: MachineId): Promise<null | Failure<"machineForbidden", null>>;
  waitOnline(
    id: MachineId,
    options?: { timeoutMs?: number },
  ): Promise<null | Failure<"machineForbidden" | "machineOffline", null>>;
}

export type MachineCreation =
  | { id: MachineId; key: string }
  | Failure<"machineLimit" | "machineForbidden", null>;

/** Unstable machine management API. May change before the first sandbox plugin. */
export function machines(ctx: ActionContext): MachineManagement;
export function machines<M extends DataModel>(
  ctx: QueryContext<M> | MutationContext<M> | CallerActionContext | ActionContext,
): MachineList;
export function machines(ctx: object): MachineList {
  const { host, besideServer } = (ctx as { readonly [machineScope]: MachineScope })[machineScope];
  const list = () => callHost(host, "machines.list", {});

  if (!besideServer) return Object.freeze({ list });

  return Object.freeze({
    list,
    create: (options) => besideServer(() => callHost(host, "machines.create", options)),
    listAll: () => besideServer(() => callHost(host, "machines.listAll", {})),
    remove: (id) => besideServer(() => callHost(host, "machines.remove", { id })),
    waitOnline: (id, options) =>
      besideServer(() =>
        callHost(host, "machines.waitOnline", {
          id,
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        }),
      ),
  } satisfies MachineManagement);
}
