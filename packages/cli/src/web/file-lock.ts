/**
 * One writer at a time across processes: the web server and a person's `kodel web pair|revoke|token`
 * read, change and write the same small files. Without the lock the server, writing when a device was
 * last seen, could put back a device a person had just revoked.
 *
 * A lock file is made exclusively; one left by a process that died is taken over once it is old.
 */
import { open, rm, stat } from "node:fs/promises";

const STALE_MS = 10_000;
const WAIT_MS = 5_000;

const busy = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EEXIST" ||
    (process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY"))
  );
};

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const until = Date.now() + WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(String(process.pid)).finally(() => handle.close());
      break;
    } catch (error) {
      if (!busy(error)) throw error;
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > until) throw new Error(`${lock} is held by another kodel; try again`);
      await pause(Math.min(10 * 2 ** attempt, 200));
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}
