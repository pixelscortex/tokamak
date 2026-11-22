declare module "virtual:built-component-addon" {
  export const manifest: {
    plugin: {
      id: string;
      contributes: { "component-action": { id: string; target: string; action: string }[] };
    };
    entries: { ui: { code: string } };
  };
  export function loadActions(): Promise<Record<string, unknown>>;
}
