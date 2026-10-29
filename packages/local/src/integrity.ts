/**
 * Where the trusted hash of a run's state is kept: outside the working tree, so an agent that
 * edits files in the repository does not know where to look. The rule it enforces is modest and
 * is stated plainly in the documentation: kodel notices files that changed behind its back; it
 * does not stop an agent with full shell access that goes looking for this directory.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { KodelError } from "@kodel-ai/pipeline-core";

/**
 * The names are run ids, or a run id plus `.seal` for the seal file's hash. A hash is first
 * *staged* (the run's file is about to change to it), then *committed* once the file is written, so
 * a crash in between leaves either value acceptable instead of looking like tampering.
 */
export interface IntegrityStore {
  /** The committed hash. */
  get(name: string): Promise<string | undefined>;
  /** Commit: this is the hash now, and nothing else is accepted. */
  set(name: string, hash: string): Promise<void>;
  /** The file is about to become `hash`; until `set`, the old hash and this one are both accepted. */
  stage(name: string, hash: string): Promise<void>;
  /** `undefined` when nothing is known about the name yet. */
  trusts(name: string, hash: string): Promise<boolean | undefined>;
}

const NAME_PATTERN = /^r_[0-9a-z]{9}_[0-9a-z]{4}(?:\.seal)?$/;

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

  /**
   * `key` replaces the one made from the path: in `home` mode the history is named by the project's
   * id and not by where it stands, so the hashes follow it when the project moves (clones of one
   * project, which share a history, then share its hashes too).
   */
  constructor(
    private readonly dir: string,
    storeRoot: string,
    key?: string,
  ) {
    // The key names the repository, so two repositories never share a hash.
    this.key =
      key === undefined
        ? stableRealpath(storeRoot).then((path) => sha256(path).slice(0, 16))
        : Promise.resolve(key);
  }

  private async path(name: string): Promise<string> {
    if (!NAME_PATTERN.test(name)) {
      throw new KodelError("UNKNOWN_RUN", `"${name}" is not a run id`);
    }
    return join(this.dir, await this.key, `${name}.sha256`);
  }

  /** The committed hash, and the staged one if a change is in flight. */
  private async read(name: string): Promise<{ committed: string; staged?: string } | undefined> {
    let text: string;
    try {
      text = await readFile(await this.path(name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const [committed, staged] = text.split("\n").map((line) => line.trim());
    if (!committed) return undefined;
    return staged ? { committed, staged } : { committed };
  }

  /** Written whole or not at all, so a crash cannot leave a half-written hash that reads as tampering. */
  private async write(name: string, committed: string, staged?: string): Promise<void> {
    const path = await this.path(name);
    await mkdir(join(this.dir, await this.key), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    await rm(tmp, { force: true });
    await writeFile(tmp, `${committed}\n${staged ?? ""}\n`, { flag: "wx" });
    await rename(tmp, path);
  }

  async get(name: string): Promise<string | undefined> {
    return (await this.read(name))?.committed;
  }

  async set(name: string, hash: string): Promise<void> {
    await this.write(name, hash);
  }

  async stage(name: string, hash: string): Promise<void> {
    const current = await this.read(name);
    await this.write(name, current?.committed ?? hash, hash);
  }

  async trusts(name: string, hash: string): Promise<boolean | undefined> {
    const current = await this.read(name);
    if (!current) return undefined;
    return hash === current.committed || hash === current.staged;
  }
}

/** For tests and for hosts that do not want the check. */
export class MemoryIntegrity implements IntegrityStore {
  readonly hashes = new Map<string, string>();
  readonly staged = new Map<string, string>();

  async get(name: string): Promise<string | undefined> {
    return this.hashes.get(name);
  }

  async set(name: string, hash: string): Promise<void> {
    this.hashes.set(name, hash);
    this.staged.delete(name);
  }

  async stage(name: string, hash: string): Promise<void> {
    if (!this.hashes.has(name)) this.hashes.set(name, hash);
    this.staged.set(name, hash);
  }

  async trusts(name: string, hash: string): Promise<boolean | undefined> {
    const committed = this.hashes.get(name);
    if (committed === undefined) return undefined;
    return hash === committed || hash === this.staged.get(name);
  }
}
