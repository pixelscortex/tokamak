// A realistic bundled feature imports a helper and throws after an async boundary.
import { describe } from "./describe";

type Request = { id: number };

export async function invoke(request: Request): Promise<never> {
  const label = describe(request.id);
  await Promise.resolve(label);
  throw new Error(`missing todo: ${label}`);
}
