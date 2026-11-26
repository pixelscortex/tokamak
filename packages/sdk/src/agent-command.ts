import type { CallerActionContext } from "./functions";
import type { RunningProcess } from "./local";
import { TIMED_OUT, within } from "./within";

/** A short CLI probe. Missing, a real exit, and no answer are distinct. */
export async function agentCommand(
  ctx: CallerActionContext,
  [name, ...args]: ["claude" | "codex", ...string[]],
  timeout: number,
  env?: Readonly<Record<string, string>>,
): Promise<{ stdout: string; code: number } | "missing" | undefined> {
  if (timeout <= 0) return;
  const notFound = new RegExp(`^tokamak-program: (?:line )?(?:\\d+: )?exec: ${name}: not found$`);
  let program: RunningProcess | undefined;
  let finished = false;
  try {
    const child = (program = ctx.proc([name, ...args], env === undefined ? undefined : { env }));
    child.closeInput();
    const result = await within(
      Promise.all([
        child.exited,
        (async () => {
          let output = "";
          for await (const line of child.stdout) {
            output += line + "\n";
            if (output.length > 64 * 1024) throw new Error("Agent probe output exceeded 64 KiB");
          }
          return output.trim();
        })(),
        (async () => {
          let missing = false;
          for await (const line of child.stderr) missing ||= notFound.test(line);
          return missing;
        })(),
      ]),
      timeout,
    );
    if (result === TIMED_OUT) return;
    finished = true;
    const [code, stdout, missing] = result;
    return code === 127 && missing ? "missing" : { code, stdout };
  } catch (error) {
    // Windows uses the executable directly.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
  } finally {
    program?.stop(finished ? undefined : "SIGKILL");
  }
}
