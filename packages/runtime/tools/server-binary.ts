/**
 * Candidate filenames for the server executable, in order of preference.
 *
 * Each `start` lookup accepts only a renamed build from the requested profile.
 * The CLI tries debug and then release. Its stop and status commands use local
 * discovery directly, so they work even when the old executable is gone.
 *
 * The executable was named `tokamak` before it was renamed `tokamak-server`.
 * The legacy candidate order still describes how to locate either filename
 * in a checkout that pulled the rename but has not rebuilt.
 */
export function serverBinaryCandidates(
  command: string,
  profile: string,
  suffix: string,
  target = "target",
): string[] {
  const other = profile === "debug" ? "release" : "debug";
  const current = `${target}/${profile}/tokamak-server${suffix}`;
  if (command === "start") return [current];
  return [
    current,
    `${target}/${other}/tokamak-server${suffix}`,
    `${target}/${profile}/tokamak${suffix}`,
    `${target}/${other}/tokamak${suffix}`,
  ];
}
