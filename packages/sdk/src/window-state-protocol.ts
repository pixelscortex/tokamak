export const windowStateModule = "tokamak:window-state";
export const readWindowState = "tokamak:readWindowState";
export const writeWindowState = "tokamak:writeWindowState";

export function isWindowStateFunction(name: string): boolean {
  return name === readWindowState || name === writeWindowState;
}
