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

/** One row of the process table. `started` is `ps`'s `lstart` text: compared with another reading, never parsed. */
export interface ProcessRow {
  pid: number;
  pgid: number;
  /** The state letters of `ps` (`Z…` is a zombie). */
  state: string;
  started: string;
}

/** What the group rule and a stop of a group ask of the system; a test gives its own. */
export interface ProcessView {
  /** The whole table, read now; `undefined` when it cannot be read (a sandbox, a `ps` without these columns). */
  rows(): ProcessRow[] | undefined;
  /** When the machine was started, in milliseconds; `undefined` when it cannot be read. */
  bootTime(): number | undefined;
  identity(pid: number): ProcessIdentity | undefined;
  signal(pid: number, signal: NodeJS.Signals): void;
}

export const parseProcessRows = (table: string): ProcessRow[] => {
  const rows: ProcessRow[] = [];
  for (const line of table.split("\n")) {
    const [pid, pgid, state, ...started] = line.trim().split(/\s+/);
    const p = Number(pid);
    const g = Number(pgid);
    if (!Number.isInteger(p) || !Number.isInteger(g) || state === undefined || started.length === 0)
      continue;
    rows.push({ pid: p, pgid: g, state, started: started.join(" ") });
  }
  return rows;
};

let cachedBoot: number | undefined | null = null;
const readBootTime = (): number | undefined => {
  if (cachedBoot !== null) return cachedBoot;
  let found: number | undefined;
  const stat = readText("/proc/stat");
  const btime = stat === undefined ? undefined : /^btime\s+(\d+)$/m.exec(stat)?.[1];
  if (btime !== undefined) found = Number(btime) * 1000;
  else if (process.platform === "darwin") {
    for (const program of ["/usr/sbin/sysctl", "sysctl"]) {
      const result = spawnSync(program, ["-n", "kern.boottime"], {
        encoding: "utf8",
        timeout: 2_000,
      });
      const sec = /\bsec\s*=\s*(\d+)/.exec(result.stdout ?? "")?.[1];
      if (result.status === 0 && sec !== undefined) {
        found = Number(sec) * 1000;
        break;
      }
    }
  }
  // Only an answer is kept: a read that failed (a sandbox) is tried again by the next listing.
  if (found !== undefined) cachedBoot = found;
  return found;
};

export const systemProcesses: ProcessView = {
  rows() {
    const table = ps(["-A", "-o", "pid=,pgid=,stat=,lstart="]);
    if (table === undefined) return undefined;
    const rows = parseProcessRows(table);
    // A table without this very process was not read in full (a `ps` that prints nothing it may not see).
    return rows.some((row) => row.pid === process.pid) ? rows : undefined;
  },
  bootTime: readBootTime,
  identity: (pid) => processIdentity(pid),
  signal(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch {
      // gone
    }
  },
};

/** A view that reads the table and the boot time once: one listing, one read, however many records ask. */
export const readOnce = (view: ProcessView): ProcessView => {
  let rows: { value: ProcessRow[] | undefined } | undefined;
  let boot: { value: number | undefined } | undefined;
  return {
    rows() {
      rows ??= { value: view.rows() };
      return rows.value;
    },
    bootTime() {
      boot ??= { value: view.bootTime() };
      return boot.value;
    },
    identity: (pid) => view.identity(pid),
    signal: (pid, signal) => view.signal(pid, signal),
  };
};

export type GroupAnswer =
  /** The process table or the boot time could not be read: nothing is said about the group. */
  | { known: false }
  /** `stranger`: the group's number is the pid of a process that is not the recorded leader. */
  | { known: true; stranger: boolean; members: ProcessRow[] };

/**
 * The live processes left in the process group `pgid` of a session that began at `since`, whose recorded leader
 * (the holder's child, `leader` its identity) may be gone. A member counts as the session's own only when the
 * table was read, the machine was not restarted after `since` (numbers start over), and no process that is not
 * the recorded leader has the group's number as its pid: the kernel gives a group's number to a new process only
 * once the group is empty, so with such a process every member is a stranger's. Otherwise, while one member
 * lives the number is not given out again, and the members are the session's.
 */
export const groupMembers = (
  pgid: number,
  since: number,
  leader: ProcessIdentity | undefined,
  view: ProcessView = systemProcesses,
): GroupAnswer => {
  if (!Number.isInteger(pgid) || pgid <= 1) return { known: true, stranger: false, members: [] };
  const rows = view.rows();
  if (rows === undefined) return { known: false };
  const members = rows.filter((row) => row.pgid === pgid && !row.state.startsWith("Z"));
  if (members.length === 0) return { known: true, stranger: false, members };
  const boot = view.bootTime();
  if (boot === undefined) return { known: false };
  if (boot > since) return { known: true, stranger: false, members: [] };
  // Whatever group that process is in now: it got the number, so the group was empty when it did.
  const head = rows.find((row) => row.pid === pgid && !row.state.startsWith("Z"));
  if (head !== undefined) {
    const now = view.identity(head.pid);
    const ours = leader !== undefined && now !== undefined && sameIdentity(leader, now) === true;
    if (!ours) return { known: true, stranger: true, members: [] };
  }
  return { known: true, stranger: false, members };
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
