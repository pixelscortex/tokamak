import { createApi, type ApiFromModule } from "@tokamak/sdk";
/** Public plugin-call references. api.ts controls host export access. */
export const chat = createApi<{
  send: Pick<ApiFromModule<typeof import("./runs/send")>, "update" | "running" | "session">;
  permissions: Pick<
    ApiFromModule<typeof import("./permissions/permissions")>,
    "request" | "state" | "claim" | "undelivered"
  >;
}>("chat");
