import { createApi, type ApiFromModule } from "@tokamak/sdk";
/** Public plugin-call references. api.ts controls host export access. */
export const chat = createApi<{
  send: Pick<ApiFromModule<typeof import("./backend/send")>, "update" | "running" | "session">;
  permissions: Pick<
    ApiFromModule<typeof import("./backend/permissions")>,
    "request" | "state" | "claim" | "undelivered"
  >;
}>("chat");
