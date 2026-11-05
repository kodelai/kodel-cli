/**
 * Whether this process runs inside the process group of a live host session's child (T-42). The holder
 * starts the child detached, so the child leads its own group and everything it starts (an agent CLI and
 * the `kodel mcp` that agent starts) inherits that group. Such a `kodel mcp` must not become a second
 * Kodel client of the person, so it serves no tools.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { isLocalSessionId } from "@kodel-ai/pipeline-core";
import { sameProcess } from "./process-table";
import { readSession, readStatus } from "./session-records";
import { resolveBase } from "./storage-paths";

export interface ProcessGroupDeps {
  platform?: NodeJS.Platform;
  pid?: number;
  /** The text of `/proc/self/stat`, or undefined when it cannot be read. */
  readProcStat?: () => string | undefined;
  /** The output of `ps -o pgid= -p <pid>`, or undefined when it fails. */
  runPs?: (pid: number) => string | undefined;
}

/** The process group from `/proc/<pid>/stat`: the third field after the last `)` (the name may hold both). */
export const parseProcStatGroup = (text: string): number | undefined => {
  const close = text.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  return positive(fields[2]);
};

export const parsePsGroup = (text: string): number | undefined => positive(text.trim());

const positive = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n > 0 ? n : undefined;
};

const defaultProcStat = (): string | undefined => {
  try {
    return readFileSync("/proc/self/stat", "utf8");
  } catch {
    return undefined;
  }
};

const defaultPs = (pid: number): string | undefined => {
  try {
    return execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    });
  } catch {
    return undefined;
  }
};

/** This process's group, or undefined when neither `/proc` (Linux) nor `ps` can say. */
export const ownProcessGroup = (deps: ProcessGroupDeps = {}): number | undefined => {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return undefined;
  const pid = deps.pid ?? process.pid;
  if (platform === "linux") {
    const text = (deps.readProcStat ?? defaultProcStat)();
    const found = text === undefined ? undefined : parseProcStatGroup(text);
    if (found !== undefined) return found;
  }
  const out = (deps.runPs ?? defaultPs)(pid);
  return out === undefined ? undefined : parsePsGroup(out);
};

export interface HostSessionDeps {
  uid?: number;
  /** Whether the recorded process is still the one that was recorded. */
  alive?: typeof sameProcess;
}

const listDirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

/** The id of a live host session whose child leads group `pgid`, in any checkout of this user. */
export const hostSessionOfGroup = (
  base: string,
  pgid: number,
  deps: HostSessionDeps = {},
): string | undefined => {
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const alive = deps.alive ?? sameProcess;
  const runDir = join(base, "run", String(uid));
  for (const checkout of listDirs(runDir)) {
    if (checkout.endsWith(".names")) continue;
    for (const id of listDirs(join(runDir, checkout))) {
      if (!isLocalSessionId(id)) continue;
      const dir = join(runDir, checkout, id);
      const session = readSession(dir);
      if (typeof session === "string" || session.spec.origin !== "host") continue;
      const status = readStatus(dir);
      if (typeof status === "string" || status.child === undefined) continue;
      if (status.child.pid !== pgid) continue;
      if (alive(status.child.pid, status.child.identity)) return session.id;
    }
  }
  return undefined;
};

export interface InsideHostSession {
  inside: boolean;
  session?: string;
  /** Why the check could not tell (it then fails open: the tools are served). */
  reason?: string;
}

export interface InsideHostSessionDeps extends ProcessGroupDeps, HostSessionDeps {
  base?: string;
  /** The user's home as the system records it (not `HOME`); `os.userInfo()` by default (tests replace it). */
  accountHome?: () => string | undefined;
  /** The home this process sees (`HOME`, through `os.homedir()`); tests give another to stand for a child's. */
  home?: () => string;
}

const systemHome = (): string | undefined => {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
};

export const insideHostSession = (
  environment: Record<string, string | undefined> = process.env,
  deps: InsideHostSessionDeps = {},
): InsideHostSession => {
  const pgid = ownProcessGroup(deps);
  if (pgid === undefined) {
    return { inside: false, reason: "the process group of this process cannot be read" };
  }
  const bases: string[] = [];
  let problem: string | undefined;
  try {
    bases.push(deps.base ?? resolveBase(environment, deps.home?.()));
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  // Under a holder (`KODEL_ENGINE=1`, which a person's own agents carry too) the environment may name
  // another HOME than the one the session was recorded under: the account's own base is looked in as
  // well. The variable only widens where the session is looked for; the process group still decides.
  if (environment.KODEL_ENGINE === "1") {
    const home = (deps.accountHome ?? systemHome)();
    if (home !== undefined) {
      const own = join(home, ".kodel");
      if (!bases.includes(own)) bases.push(own);
    }
  }
  if (bases.length === 0)
    return { inside: false, ...(problem === undefined ? {} : { reason: problem }) };
  let session: string | undefined;
  for (const base of bases) {
    session = hostSessionOfGroup(base, pgid, deps);
    if (session !== undefined) break;
  }
  return session === undefined ? { inside: false } : { inside: true, session };
};
