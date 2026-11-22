/**
 * Whether a command runs inside a kodel agent session (T-45): the third guard of a person's commands.
 * An agent in a terminal of its own has a terminal, which a print worker never had, so "is there a
 * terminal" no longer tells an agent's command from a person's. This asks the process table instead:
 * the command is inside when one of its parent processes, up to the root, is the holder of a live
 * session of this state base or the process that holder started, or when the leader of the command's
 * terminal session is the process a holder started.
 *
 * A guard against mistakes, not a boundary: a process that leaves its session and gets itself a
 * terminal of its own passes, as it did before. Where the table cannot be read the answer is `unknown`
 * and the older guards decide (a person in a sandbox must still be able to decide).
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type ProcessIdentity, processIdentity, sameIdentity } from "./process-table";
import { readStatus } from "./session-records";

export type InsideSession = "inside" | "outside" | "unknown";

/** One row of the table the guard reads: who started the process, and the terminal it is on. */
export interface GuardRow {
  pid: number;
  ppid: number;
  /** The state letters of `ps`; an `s` among them marks the leader of a session. */
  state: string;
  /** The terminal as `ps` names it; `?` or `??` for none. */
  tty: string;
}

export interface GuardView {
  /** The whole table, read now; `undefined` when it cannot be read. */
  rows(): GuardRow[] | undefined;
  identity(pid: number): ProcessIdentity | undefined;
}

/** A process a session record names: the holder, or the process the holder started. */
export interface GuardProcess {
  pid: number;
  identity?: ProcessIdentity;
}

/** A session whose record says it runs. */
export interface GuardSession {
  holder?: GuardProcess;
  child?: GuardProcess;
}

export const parseGuardRows = (table: string): GuardRow[] => {
  const rows: GuardRow[] = [];
  for (const line of table.split("\n")) {
    const [pid, ppid, state, tty] = line.trim().split(/\s+/);
    const p = Number(pid);
    const pp = Number(ppid);
    if (!Number.isInteger(p) || !Number.isInteger(pp) || state === undefined || tty === undefined) {
      continue;
    }
    rows.push({ pid: p, ppid: pp, state, tty });
  }
  return rows;
};

export const systemGuardView: GuardView = {
  rows() {
    const result = spawnSync("ps", ["-A", "-o", "pid=,ppid=,stat=,tty="], {
      encoding: "utf8",
      timeout: 2_000,
      env: { ...process.env, LC_ALL: "C" },
    });
    if (result.status !== 0 || result.error) return undefined;
    const rows = parseGuardRows(result.stdout);
    // A table without this very process was not read in full.
    return rows.some((row) => row.pid === process.pid) ? rows : undefined;
  },
  identity: (pid) => processIdentity(pid),
};

/**
 * The sessions of a state base whose record says they run, of every checkout of this user. A record that
 * cannot be read names nobody. Reads files only.
 */
export function runningSessions(base: string, uid?: number): GuardSession[] {
  const user = uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const runDir = join(base, "run", String(user));
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  };
  const sessions: GuardSession[] = [];
  for (const checkout of list(runDir)) {
    if (checkout.endsWith(".names")) continue;
    for (const id of list(join(runDir, checkout))) {
      const status = readStatus(join(runDir, checkout, id));
      if (typeof status === "string") continue;
      if (status.state !== "running" && status.state !== "starting") continue;
      if (status.holder === undefined && status.child === undefined) continue;
      sessions.push({
        ...(status.holder === undefined ? {} : { holder: status.holder }),
        ...(status.child === undefined ? {} : { child: status.child }),
      });
    }
  }
  return sessions;
}

const NO_TERMINAL = ["?", "??", "-", ""];

/**
 * The answer for the process `pid`. With no running session nothing is asked of the system: the answer
 * is `outside`. A pid that is a record's but whose identity differs is another process that got the
 * number; one whose identity cannot be read now counts as the record's (the guard refuses on a doubt).
 */
export function insideSession(input: {
  pid: number;
  sessions: readonly GuardSession[];
  view?: GuardView;
}): InsideSession {
  if (input.sessions.length === 0) return "outside";
  const view = input.view ?? systemGuardView;
  const rows = view.rows();
  if (rows === undefined) return "unknown";
  const byPid = new Map(rows.map((row) => [row.pid, row] as const));
  const self = byPid.get(input.pid);
  if (self === undefined) return "unknown";
  const is = (recorded: GuardProcess | undefined, pid: number): boolean => {
    if (recorded === undefined || recorded.pid !== pid) return false;
    if (recorded.identity === undefined) return true;
    const now = view.identity(pid);
    return now === undefined || sameIdentity(recorded.identity, now) !== false;
  };
  // The parents, up to the root: the holder of a session, or the process it started.
  const seen = new Set<number>([input.pid]);
  let at = self.ppid;
  while (at > 1 && !seen.has(at)) {
    seen.add(at);
    const parent = at;
    if (input.sessions.some((s) => is(s.holder, parent) || is(s.child, parent))) return "inside";
    const row = byPid.get(parent);
    if (row === undefined) break;
    at = row.ppid;
  }
  // The terminal the command is on: its session's leader is the process a holder started in it.
  if (!NO_TERMINAL.includes(self.tty)) {
    const leaders = rows.filter((row) => row.tty === self.tty && row.state.includes("s"));
    for (const leader of leaders) {
      if (input.sessions.some((s) => is(s.child, leader.pid))) return "inside";
    }
  }
  return "outside";
}

/** The guard as the CLI asks it: for this process, against the sessions of the state base. Never throws. */
export function insideSessionOf(base: string, pid: number = process.pid): InsideSession {
  try {
    return insideSession({ pid, sessions: runningSessions(base) });
  } catch {
    return "unknown";
  }
}
