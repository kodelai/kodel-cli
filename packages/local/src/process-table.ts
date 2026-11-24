import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

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
  /** The command line of a process, for a person to read; `undefined` when it cannot be read. */
  command(pid: number): string | undefined;
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
  command(pid) {
    const text = ps(["-o", "command=", "-p", String(pid)])?.trim();
    return text === undefined || text === "" ? undefined : text;
  },
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
    command: (pid) => view.command(pid),
    signal: (pid, signal) => view.signal(pid, signal),
  };
};

export type GroupAnswer =
  /**
   * The process table or the boot time could not be read, or the process that has the group's number as its pid
   * could not be told from the recorded leader: nothing is said about the group.
   */
  | { known: false }
  /** `stranger`: the group's number is the pid of a process that is not the recorded leader. */
  | { known: true; stranger: boolean; members: ProcessRow[] };

/**
 * The live processes in the process group `pgid` of a session that began at `since`, whose recorded leader
 * (the holder's child, `leader` its identity) may be gone. No member counts when the machine was restarted after
 * `since` (numbers start over), or when a process that is not the recorded leader has the group's number as its
 * pid (`stranger`): the kernel gives a group's number to a new process only once the group is empty.
 *
 * Members of a group whose leader is gone are **not known to be the session's**: once the group was empty its
 * number may have gone to a process that made a group of it and went away, leaving its own children there. So
 * they count for "something may still run" (fail closed: nothing takes the session for finished), and nobody
 * signals them: a group is signalled only while its recorded leader lives.
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
    if (leader === undefined) return { known: true, stranger: true, members: [] };
    const now = view.identity(head.pid);
    // An identity that cannot be read or compared now says nothing (as `sameProcess` and the guard take it):
    // the process is not called a stranger on a guess.
    const same = now === undefined ? undefined : sameIdentity(leader, now);
    if (same === undefined) return { known: false };
    if (!same) return { known: true, stranger: true, members: [] };
  }
  return { known: true, stranger: false, members };
};

/** A moment on the clock the start times of one method are read on; `mono` is this process's own steady clock. */
export interface StartMark {
  method: ProcessIdentity["method"];
  /** `proc-ticks`: clock ticks since the boot. `ps-lstart`: milliseconds of the wall clock. */
  at: number;
  mono: number;
}

/** A process with the moment it started, on the clock of its identity's method. */
export interface StartedRow {
  pid: number;
  pgid: number;
  /** The session's number, where the table gives it (`/proc`). */
  session?: number;
  zombie: boolean;
  started: number;
  identity: ProcessIdentity;
}

/** What a sweep of a group whose leader is gone asks of the system; a test gives its own. */
export interface StartClock {
  /** Now, on the clock the start times are read on; `undefined` when it cannot be read. */
  now(): StartMark | undefined;
  /** The whole table, read now; `undefined` when it cannot be read. */
  rows(): StartedRow[] | undefined;
  identity(pid: number): ProcessIdentity | undefined;
}

/** How far the wall clock may run apart from the steady one before a `ps-lstart` reading says nothing. */
const CLOCK_TOLERANCE_MS = 100;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The start of the second `ps` printed as `lstart` (under `LC_ALL=C TZ=UTC0`), in milliseconds. */
export const parseLstart = (text: string): number | undefined => {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1] as string);
  if (month < 0) return undefined;
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
};

let cachedTick: number | undefined | null = null;
const ticksPerSecond = (): number | undefined => {
  if (cachedTick !== null) return cachedTick;
  const result = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 2_000 });
  const value = result.status === 0 ? Number(result.stdout.trim()) : Number.NaN;
  cachedTick = Number.isInteger(value) && value > 0 ? value : undefined;
  return cachedTick;
};

const procRows = (): StartedRow[] | undefined => {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return undefined;
  }
  const boot = readText("/proc/sys/kernel/random/boot_id")?.trim();
  const rows: StartedRow[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const fields = procStat(pid);
    const pgid = Number(fields?.[2]);
    const session = Number(fields?.[3]);
    const ticks = fields?.[19];
    const started = Number(ticks);
    if (fields === undefined || ticks === undefined) continue;
    if (!Number.isInteger(pgid) || !Number.isInteger(session) || !Number.isInteger(started))
      continue;
    const identity: ProcessIdentity =
      boot === undefined
        ? { method: "proc-ticks", value: ticks }
        : { method: "proc-ticks", value: ticks, boot };
    rows.push({ pid, pgid, session, zombie: fields[0] === "Z", started, identity });
  }
  return rows;
};

export const systemStartClock: StartClock = {
  now() {
    const mono = performance.now();
    if (procStat(process.pid) === undefined) return { method: "ps-lstart", at: Date.now(), mono };
    const uptime = Number(readText("/proc/uptime")?.split(" ")[0]);
    const tick = ticksPerSecond();
    if (!Number.isFinite(uptime) || tick === undefined) return undefined;
    return { method: "proc-ticks", at: Math.floor(uptime * tick), mono };
  },
  rows() {
    let rows: StartedRow[] | undefined;
    if (procStat(process.pid) !== undefined) rows = procRows();
    else {
      const table = systemProcesses.rows();
      rows = table?.flatMap((row) => {
        const started = parseLstart(row.started);
        if (started === undefined) return [];
        const identity: ProcessIdentity = { method: "ps-lstart", value: row.started };
        return [
          { pid: row.pid, pgid: row.pgid, zombie: row.state.startsWith("Z"), started, identity },
        ];
      });
    }
    // A table without this very process was not read in full.
    return rows?.some((row) => row.pid === process.pid) ? rows : undefined;
  },
  identity: (pid) => processIdentity(pid),
};

/**
 * The live processes of the group `pgid` that had started before `mark`, a moment at which the group was known
 * to be this program's (its leader lived). The group's number was in use then, so no other group had it: a
 * process that is in a group of that number now and started before that moment is of the group that was meant,
 * whoever has the number since. A process that started in the same tick (`proc-ticks`) or the same second
 * (`ps-lstart`) as the mark is left out, and so is one in another session where the table tells (a session's
 * number is given out again only after its last process, and an older process cannot join a new one).
 * `undefined` when it cannot be told: another method than the mark's, or a wall clock that was set back since
 * the mark (`later` is now), which would make a new process look old.
 */
export const startedBefore = (
  rows: StartedRow[],
  pgid: number,
  mark: StartMark,
  later: StartMark,
): StartedRow[] | undefined => {
  if (later.method !== mark.method) return undefined;
  let limit = mark.at;
  if (mark.method === "ps-lstart") {
    if (later.at - mark.at < later.mono - mark.mono - CLOCK_TOLERANCE_MS) return undefined;
    // The whole second of the start lies before the mark, the tolerance taken off.
    limit = mark.at - CLOCK_TOLERANCE_MS - 999;
  }
  return rows.filter(
    (row) =>
      row.pgid === pgid &&
      !row.zombie &&
      row.identity.method === mark.method &&
      (row.session === undefined || row.session === pgid) &&
      row.started < limit,
  );
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
