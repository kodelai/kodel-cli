/** What the tests that bind a unix socket share: a short folder, whether a bind works here, leftover sockets. */
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindSessionSocket } from "../../src/session-socket";

export const uid = typeof process.getuid === "function" ? process.getuid() : 0;

/**
 * A folder whose path leaves room for a socket name: the test runner's `TMPDIR` on macOS is longer than
 * `sun_path`, so `/tmp` is tried first.
 */
export const shortDir = (prefix = "kd-"): string => {
  try {
    return mkdtempSync(join("/tmp", prefix));
  } catch {
    return mkdtempSync(join(tmpdir(), prefix));
  }
};

const probe = async (): Promise<string | undefined> => {
  if (process.platform === "win32") return "unix sockets of a session are not used on Windows";
  const dir = shortDir("kd-probe-");
  try {
    (await bindSessionSocket([{ kind: "run", dir, path: join(dir, "p.sock") }], uid)).close();
    return undefined;
  } catch (error) {
    return `a unix socket cannot be bound here (${(error as Error).message})`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Why the tests that need a bound socket are skipped, or `undefined` when they run. */
export const socketSkipReason = await probe();
if (socketSkipReason !== undefined) {
  // A skip is never a pass: where a terminal must work (the CI job), it is a failure.
  if (process.env.KODEL_REQUIRE_PTY === "1") throw new Error(socketSkipReason);
  console.log(`socket tests skipped: ${socketSkipReason}`);
}

const listening = (path: string): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.on("error", () => {}));
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });

/** A socket somebody listens on, at `path`. */
export const liveSocket = (path: string): Promise<Server> => listening(path);

/** A socket file nobody listens on: what a holder that was killed leaves. */
export const staleSocket = async (path: string): Promise<void> => {
  // Closing a server removes the file it was bound at; renamed first, the file stays.
  const server = await listening(`${path}.tmp`);
  renameSync(`${path}.tmp`, path);
  await new Promise<void>((resolve) => server.close(() => resolve()));
};
