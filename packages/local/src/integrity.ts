/**
 * Where the trusted hash of a run's state is kept: outside the working tree, so an agent that
 * edits files in the repository does not know where to look. The rule it enforces is modest and
 * is stated plainly in the documentation: kodel notices files that changed behind its back; it
 * does not stop an agent with full shell access that goes looking for this directory.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface IntegrityStore {
  get(runId: string): Promise<string | undefined>;
  set(runId: string, hash: string): Promise<void>;
}

export const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/** `$KODEL_STATE_DIR`, else `$XDG_STATE_HOME/kodel`, else `~/.local/state/kodel`. */
export function defaultIntegrityDir(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  if (env.KODEL_STATE_DIR) return env.KODEL_STATE_DIR;
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "kodel");
}

/**
 * The real path of a location that may not exist yet: the real path of its nearest existing parent
 * plus the rest. The same repository gets the same key before and after `.kodel` is created, and
 * through a symlink (`/var` and `/private/var` on macOS).
 */
async function stableRealpath(path: string): Promise<string> {
  const absolute = resolve(path);
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(await realpath(current), ...[...rest].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** Hashes in files under `<dir>/<repository key>/<run id>.sha256`. */
export class FileIntegrity implements IntegrityStore {
  private key: Promise<string>;

  constructor(
    private readonly dir: string,
    storeRoot: string,
  ) {
    // The key names the repository, so two repositories never share a hash.
    this.key = stableRealpath(storeRoot).then((path) => sha256(path).slice(0, 16));
  }

  private async path(runId: string): Promise<string> {
    return join(this.dir, await this.key, `${runId}.sha256`);
  }

  async get(runId: string): Promise<string | undefined> {
    try {
      return (await readFile(await this.path(runId), "utf8")).trim() || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async set(runId: string, hash: string): Promise<void> {
    const path = await this.path(runId);
    await mkdir(join(this.dir, await this.key), { recursive: true });
    await writeFile(path, `${hash}\n`);
  }
}

/** For tests and for hosts that do not want the check. */
export class MemoryIntegrity implements IntegrityStore {
  readonly hashes = new Map<string, string>();

  async get(runId: string): Promise<string | undefined> {
    return this.hashes.get(runId);
  }

  async set(runId: string, hash: string): Promise<void> {
    this.hashes.set(runId, hash);
  }
}
