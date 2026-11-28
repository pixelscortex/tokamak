declare module "virtual:built-component-addon" {
  export const manifest: {
    plugin: {
      id: string;
      contributes: { "component-action": { id: string; target: string; action: string }[] };
    };
    entries: { ui: { code: string } };
  };
  type Owner = {
    Composer: typeof import("./fixtures/parts/owner/src/client/api").Composer;
    find: typeof import("./fixtures/parts/owner/src/client/_generated/components").find;
  };
  export const moved: Owner;
  export const duplicate: Owner;
  export const changed: Owner;
  export const noUploadLabel: Owner;
  export const noComposer: Owner;
  export const attachmentWarnings: string;
  export const filteredWarnings: string;
  export const warnings: string;
  export function loadActions(): Promise<Record<string, unknown>>;
}
