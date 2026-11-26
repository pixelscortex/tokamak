import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  build,
  copySource,
  signInMember as signInWithMethod,
  workspace,
} from "../../../e2e/fake-agent/harness.mjs";

export const signInMethod = "fixture-sign-in";

export function copySignInFixture(destination) {
  return copySource(
    join(import.meta.dir, "fixtures/sign-in"),
    destination,
    join(workspace, "app/node_modules"),
  );
}

export async function installSignInFixture(pluginsDir) {
  const root = dirname(pluginsDir);
  await mkdir(root, { recursive: true });
  // Each driver owns its scratch directory. Generated files must stay out of the shared fixture.
  const source = await mkdtemp(join(root, "sign-in-source-"));
  await copySignInFixture(source);
  build(source);
  await cp(join(source, "dist"), join(pluginsDir, signInMethod), {
    recursive: true,
  });
}

export function signInMember(address, ownerKey, username) {
  return signInWithMethod(address, ownerKey, username, signInMethod);
}
