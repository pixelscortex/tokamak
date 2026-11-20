import { expect, test } from "bun:test";
import { serverBinaryCandidates } from "../tools/server-binary";

test("start only accepts the renamed build of the requested profile", () => {
  expect(serverBinaryCandidates("start", "debug", "")).toEqual(["target/debug/tokamak-server"]);
});

test("stop and status still find a build made before the rename", () => {
  for (const command of ["stop", "status"]) {
    const candidates = serverBinaryCandidates(command, "debug", ".exe");
    expect(candidates[0]).toBe("target/debug/tokamak-server.exe");
    expect(candidates).toContain("target/debug/tokamak.exe");
    expect(candidates).toContain("target/release/tokamak.exe");
    // The renamed builds are preferred over the old name in either profile.
    expect(candidates.indexOf("target/release/tokamak-server.exe")).toBeLessThan(
      candidates.indexOf("target/debug/tokamak.exe"),
    );
  }
});
