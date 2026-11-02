import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** A process identity: the same pid with another start time is another process. Compared only within one method. */
export interface ProcessIdentity {
  method: "proc-ticks" | "ps-lstart";
  value: string;
  boot?: string;
}

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const ps = (args: string[]): string | undefined => {
  const result = spawnSync("ps", args, {
    encoding: "utf8",
    timeout: 2_000,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
  });
  if (result.status !== 0 || result.error) return undefined;
  return result.stdout;
};

/** Fields of `/proc/<pid>/stat` after the command name (which may hold spaces and parentheses). */
const procStat = (pid: number): string[] | undefined => {
  const text = readText(`/proc/${pid}/stat`);
  if (text === undefined) return undefined;
  const close = text.lastIndexOf(")");
  if (close < 0) return undefined;
  return text.slice(close + 2).split(" ");
};

const signalZero = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Alive and not a zombie: a zombie holder that nothing reaps counts as gone. */
export const liveProcess = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0 || !signalZero(pid)) return false;
  const fields = procStat(pid);
  if (fields !== undefined) return fields[0] !== "Z";
  const state = ps(["-o", "stat=", "-p", String(pid)]);
  if (state === undefined) return true; // cannot tell: the signal said it exists
  return !state.trim().startsWith("Z");
};

export const processIdentity = (pid: number): ProcessIdentity | undefined => {
  const fields = procStat(pid);
  if (fields !== undefined) {
    const ticks = fields[19]; // field 22 of the file, 0-based 19 after the state field
    const boot = readText("/proc/sys/kernel/random/boot_id")?.trim();
    if (ticks === undefined) return undefined;
    return boot === undefined
      ? { method: "proc-ticks", value: ticks }
      : { method: "proc-ticks", value: ticks, boot };
  }
  const started = ps(["-o", "lstart=", "-p", String(pid)])?.trim();
  if (started === undefined || started === "") return undefined;
  return { method: "ps-lstart", value: started };
};

/** `true` and `false` when both sides can be compared; `undefined` when they cannot (fail closed). */
export const sameIdentity = (a: ProcessIdentity, b: ProcessIdentity): boolean | undefined => {
  if (a.method !== b.method) return undefined;
  if (a.boot !== undefined && b.boot !== undefined && a.boot !== b.boot) return false;
  return a.value === b.value;
};

/** Every descendant of `pid`, children first; a walk of the process table by parent id. */
export const descendantsOf = (pid: number): number[] => {
  const table = ps(["-A", "-o", "pid=,ppid="]);
  if (table === undefined) return [];
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (p === undefined || pp === undefined || Number.isNaN(p) || Number.isNaN(pp)) continue;
    children.set(pp, [...(children.get(pp) ?? []), p]);
  }
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const next = queue.shift() as number;
    for (const child of children.get(next) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found.reverse();
};

/**
 * The pid is alive and, when an identity was recorded, still the same process. A recycled pid is not the process
 * that was recorded. When the identity cannot be read now the process counts as alive (never declare a session
 * lost on a guess).
 */
export const sameProcess = (pid: number, identity: ProcessIdentity | undefined): boolean => {
  if (!liveProcess(pid)) return false;
  if (!identity) return true;
  const now = processIdentity(pid);
  if (!now) return true;
  return sameIdentity(identity, now) !== false;
};

let cachedMachine: string | undefined | null = null;
/** An id of this machine, or `undefined` when it cannot be read (then no session is judged foreign). */
export const machineId = (): string | undefined => {
  if (cachedMachine !== null) return cachedMachine;
  let found: string | undefined;
  const linux = readText("/etc/machine-id")?.trim();
  if (linux) found = linux;
  else if (process.platform === "darwin") {
    const result = spawnSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(result.stdout ?? "");
    if (match?.[1]) found = match[1];
  }
  cachedMachine = found;
  return found;
};
