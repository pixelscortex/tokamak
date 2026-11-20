/**
 * Where `server:start`, `server:stop` and `server:status` look for the server
 * executable, in order of preference.
 *
 * `start` only accepts the build of the requested profile. `stop` and `status`
 * need the executable just to locate a running local server, so they also
 * accept the other profile's build.
 *
 * The executable was named `tokamak` before it was renamed `tokamak-server`.
 * A checkout that pulled the rename but has not rebuilt yet still has only the
 * old file on disk, and may have an old server running. `stop` and `status`
 * fall back to the old name so that server can still be found and stopped.
 * Remove the old name once nobody can have a pre-rename build left.
 */
export function serverBinaryCandidates(command: string, profile: string, suffix: string): string[] {
  const other = profile === "debug" ? "release" : "debug";
  const current = `target/${profile}/tokamak-server${suffix}`;
  if (command === "start") return [current];
  return [
    current,
    `target/${other}/tokamak-server${suffix}`,
    `target/${profile}/tokamak${suffix}`,
    `target/${other}/tokamak${suffix}`,
  ];
}
