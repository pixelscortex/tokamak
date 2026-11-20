export const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;

export async function acquireLock(
  acquire: () => Promise<unknown>,
  timeout: number,
  busy: (error: unknown) => Promise<void>,
  description: string,
) {
  const deadline = performance.now() + timeout;
  while (true) {
    try {
      await acquire();
      return;
    } catch (error) {
      await busy(error);
      if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
      await new Promise((done) => setTimeout(done, 25 + Math.random() * 50));
    }
  }
}
