declare module "virtual:built-component-addon" {
  export const manifest: {
    plugin: {
      id: string;
      contributes: { "component-action": { id: string; target: string; action: string }[] };
    };
    entries: { ui: { code: string } };
  };
  export const renamedParts: object;
  export const RenamedComposer: typeof import("./fixtures/parts/owner/src/client/api").Composer;
  export function loadActions(): Promise<Record<string, unknown>>;
}
