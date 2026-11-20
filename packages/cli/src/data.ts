import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function dataFolder() {
  if (process.env.TOKAMAK_SERVER_DIR) return resolve(process.env.TOKAMAK_SERVER_DIR);
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "com.pixelscortex.Tokamak");
  }
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA || join(home, "AppData", "Local"),
      "pixelscortex",
      "Tokamak",
      "data",
    );
  }
  const xdg = process.env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "tokamak");
}
