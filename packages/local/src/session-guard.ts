/**
 * Whether a command runs inside a kodel agent session (T-47): the third guard of a person's commands.
 * An agent in a terminal of its own has a terminal, which a print worker never had, so "is there a
 * terminal" no longer tells an agent's command from a person's. This asks the process table instead:
 * the command is inside when one of its parent processes, up to the root, is the holder of a live
 * session or the process that holder started, or when the leader of the command's terminal session is
 * the process a holder started.
 *
 * A holder is known in two ways. By its own command line, which always ends with `HOLDER_MARKER`: this
 * finds a session whatever state base its record was written under (a session's environment gets no
 * `KODEL_*`, so a command inside one resolves the default base, not the `KODEL_STATE_DIR` of the shell
 * that started it). And by the records of the state base the command resolves, which also name the
 * process a holder started: this finds an agent whose holder is gone, also one whose holder recorded
 * `killed` or `lost` while the process it started still runs.
 *
 * A guard against mistakes, not a boundary: a process that leaves its session and gets itself a
 * terminal of its own passes, as it did before. Where the table cannot be read the answer is `unknown`
 * and the older guards decide (a person in a sandbox must still be able to decide).
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type ProcessIdentity, processIdentity, sameIdentity } from "./process-table";
import { HOLDER_MARKER } from "./session-holder";
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
  /** The command line as `ps` prints it; absent when the table has none for the process. */
  args?: string;
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

/** A session whose record says it runs, or the process a session that is over may have left running. */
export interface GuardSession {
  holder?: GuardProcess;
  child?: GuardProcess;
}

export const parseGuardRows = (table: string): GuardRow[] => {
  const rows: GuardRow[] = [];
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*\S))?\s*$/.exec(line);
    if (match === null) continue;
    const [, pid, ppid, state, tty, args] = match;
    if (state === undefined || tty === undefined) continue;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      state,
      tty,
      ...(args === undefined ? {} : { args }),
    });
  }
  return rows;
};

export const systemGuardView: GuardView = {
  rows() {
    // `-ww`: a command line is never cut to a width, so its last word is the real one.
    const result = spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,stat=,tty=,args="], {
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
 * The sessions of a state base that may still run, of every checkout of this user: those whose record says
 * they run, and those whose holder recorded `killed` or `lost` for a child that may have outlived it (by the
 * child alone; whether that pid is still the child is asked of the table, by its identity). A record that
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
      if (status.state === "running" || status.state === "starting") {
        if (status.holder === undefined && status.child === undefined) continue;
        sessions.push({
          ...(status.holder === undefined ? {} : { holder: status.holder }),
          ...(status.child === undefined ? {} : { child: status.child }),
        });
      } else if ((status.state === "killed" || status.state === "lost") && status.child) {
        // The holder is over; the process it started may not be (a child that outlived its stop).
        sessions.push({ child: status.child });
      }
    }
  }
  return sessions;
}

const NO_TERMINAL = ["?", "??", "-", ""];

/**
 * A process that runs as the holder of a session: the last word of its command line is the marker the
 * intermediate process gives every holder. Nothing a session's child does can change the command line of
 * its holder; a process that gives itself the marker only gets its own descendants refused.
 */
export const isHolderRow = (row: GuardRow | undefined): boolean =>
  row?.args !== undefined && row.args.split(/\s+/).at(-1) === HOLDER_MARKER;

/**
 * The answer for the process `pid`. The table is read whether or not `sessions` names anybody: a holder
 * is known by its command line too, so a session of another state base is found. A pid that is a
 * record's but whose identity differs is another process that got the number; one whose identity cannot
 * be read now counts as the record's (the guard refuses on a doubt).
 */
export function insideSession(input: {
  pid: number;
  sessions: readonly GuardSession[];
  view?: GuardView;
}): InsideSession {
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
    const row = byPid.get(parent);
    if (isHolderRow(row)) return "inside";
    if (input.sessions.some((s) => is(s.holder, parent) || is(s.child, parent))) return "inside";
    if (row === undefined) break;
    at = row.ppid;
  }
  // The terminal the command is on: its session's leader is the process a holder started in it.
  if (!NO_TERMINAL.includes(self.tty)) {
    const leaders = rows.filter((row) => row.tty === self.tty && row.state.includes("s"));
    for (const leader of leaders) {
      if (isHolderRow(byPid.get(leader.ppid))) return "inside";
      if (input.sessions.some((s) => is(s.child, leader.pid))) return "inside";
    }
  }
  return "outside";
}

/**
 * The guard as the CLI asks it: for this process, against the holders that run on this machine and the
 * sessions of the state base. Never throws.
 */
export function insideSessionOf(
  base: string,
  pid: number = process.pid,
  view?: GuardView,
): InsideSession {
  try {
    return insideSession({ pid, sessions: runningSessions(base), ...(view ? { view } : {}) });
  } catch {
    return "unknown";
  }
}
