export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1 || pid > 0x7fffffff) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
