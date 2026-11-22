/**
 * The probe behind the third guard of a person's commands (T-45): is this command inside a kodel agent
 * session? A fake process table and fake session records; the files of a real state base for the reader.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GuardRow,
  type GuardSession,
  type GuardView,
  insideSession,
  insideSessionOf,
  isHolderRow,
  type ProcessIdentity,
  parseGuardRows,
  runningSessions,
} from "../src";

const HOLDER_MARKER = "--kodel-session-holder";

const id = (value: string): ProcessIdentity => ({ method: "ps-lstart", value });

/** pid, parent, state letters, terminal. */
const table = (rows: [number, number, string, string][]): GuardRow[] =>
  rows.map(([pid, ppid, state, tty]) => ({ pid, ppid, state, tty }));

const view = (
  rows: GuardRow[] | undefined,
  identities: Record<number, string> = {},
): GuardView => ({
  rows: () => rows,
  identity: (pid) => (pid in identities ? id(identities[pid] ?? "") : undefined),
});

const HOLDER = 500;
const AGENT = 510;
const SESSION: GuardSession = {
  holder: { pid: HOLDER, identity: id("holder") },
  child: { pid: AGENT, identity: id("agent") },
};
const IDS = { [HOLDER]: "holder", [AGENT]: "agent" };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the session guard's probe", () => {
  test("tA_inside_session_probe", () => {
    // As the spike saw it: the agent's shell command is in a process group of its own with no terminal,
    // and its parents lead to the agent and to the holder.
    const worker = table([
      [1, 0, "Ss", "??"],
      [HOLDER, 1, "S", "??"],
      [AGENT, HOLDER, "Ss+", "ttys009"],
      [600, AGENT, "S", "??"],
      [601, 600, "S", "??"],
    ]);
    expect(insideSession({ pid: 601, sessions: [SESSION], view: view(worker, IDS) })).toBe(
      "inside",
    );
    expect(insideSession({ pid: 600, sessions: [SESSION], view: view(worker, IDS) })).toBe(
      "inside",
    );
    // The holder went away and the agent hangs under the root: the process it started is a parent still.
    const orphaned = table([
      [1, 0, "Ss", "??"],
      [AGENT, 1, "Ss", "??"],
      [600, AGENT, "S", "??"],
    ]);
    expect(insideSession({ pid: 600, sessions: [SESSION], view: view(orphaned, IDS) })).toBe(
      "inside",
    );
    // A person's shell beside it: no session among its parents, a terminal of its own.
    const person = table([
      [1, 0, "Ss", "??"],
      [HOLDER, 1, "S", "??"],
      [AGENT, HOLDER, "Ss+", "ttys009"],
      [700, 1, "Ss", "ttys001"],
      [701, 700, "S+", "ttys001"],
    ]);
    expect(insideSession({ pid: 701, sessions: [SESSION], view: view(person, IDS) })).toBe(
      "outside",
    );
    let asked = 0;
    const counting: GuardView = {
      rows: () => {
        asked += 1;
        return person;
      },
      identity: () => undefined,
    };
    // With no record of a session the table is read all the same: a holder is known by its command line.
    expect(insideSession({ pid: 701, sessions: [], view: counting })).toBe("outside");
    expect(asked).toBe(1);
    // The table cannot be read, or does not hold the command itself: nothing is said.
    expect(insideSession({ pid: 701, sessions: [SESSION], view: view(undefined) })).toBe("unknown");
    expect(insideSession({ pid: 999, sessions: [SESSION], view: view(person, IDS) })).toBe(
      "unknown",
    );
  });

  test("tA_inside_session_probe_knows_a_holder_of_another_state_base", () => {
    // The session was started under `KODEL_STATE_DIR`; its child's environment has no `KODEL_*`, so the
    // command resolves the default state base, which has no record of it. The holder among its parents
    // is known by the last word of its own command line.
    const holder = `/usr/bin/node /opt/kodel/dist/kodel.js session-holder holder ${HOLDER_MARKER}`;
    const rows: GuardRow[] = [
      { pid: 1, ppid: 0, state: "Ss", tty: "??", args: "/sbin/launchd" },
      { pid: HOLDER, ppid: 1, state: "S", tty: "??", args: holder },
      { pid: AGENT, ppid: HOLDER, state: "Ss+", tty: "ttys009", args: "claude --session-id x" },
      { pid: 600, ppid: AGENT, state: "S", tty: "??", args: "zsh -c kodel gate approve r_1" },
      { pid: 601, ppid: 600, state: "S", tty: "??", args: "node kodel.js gate approve r_1" },
      // A command that left its parents but runs on the session's terminal.
      { pid: 800, ppid: 1, state: "S+", tty: "ttys009", args: "node kodel.js gate approve r_1" },
      // A person's shell, and a person's command that only names the marker in its arguments.
      { pid: 700, ppid: 1, state: "Ss", tty: "ttys001", args: "-zsh" },
      { pid: 701, ppid: 700, state: "S+", tty: "ttys001", args: "node kodel.js gate approve r_1" },
      { pid: 702, ppid: 700, state: "S+", tty: "ttys001", args: `grep -r -- ${HOLDER_MARKER} src` },
      { pid: 703, ppid: 702, state: "S+", tty: "ttys001", args: "node kodel.js gate approve r_1" },
    ];
    const ask = (pid: number) => insideSession({ pid, sessions: [], view: view(rows) });
    expect(ask(600)).toBe("inside");
    expect(ask(601)).toBe("inside");
    expect(ask(800)).toBe("inside");
    expect(ask(701)).toBe("outside");
    expect(ask(703)).toBe("outside");
    // A table without command lines (the older shape) knows a holder by the records alone.
    const bare = rows.map(({ args: _args, ...row }) => row);
    expect(insideSession({ pid: 601, sessions: [], view: view(bare) })).toBe("outside");
    expect(insideSession({ pid: 601, sessions: [SESSION], view: view(bare, IDS) })).toBe("inside");
    // Still nothing is said where the table cannot be read.
    expect(insideSession({ pid: 601, sessions: [], view: view(undefined) })).toBe("unknown");
    expect(isHolderRow({ pid: 2, ppid: 1, state: "S", tty: "??", args: HOLDER_MARKER })).toBe(true);
    expect(isHolderRow({ pid: 2, ppid: 1, state: "S", tty: "??" })).toBe(false);
    expect(isHolderRow(undefined)).toBe(false);
  });

  test("tA_inside_session_probe_reads_the_terminal_session", () => {
    // A command that left its parents behind (its parent is the root) but still runs on the session's
    // terminal: the leader of that terminal's session is the process the holder started.
    const detached = table([
      [1, 0, "Ss", "??"],
      [HOLDER, 1, "S", "??"],
      [AGENT, HOLDER, "Ss", "pts/7"],
      [800, 1, "S+", "pts/7"],
    ]);
    expect(insideSession({ pid: 800, sessions: [SESSION], view: view(detached, IDS) })).toBe(
      "inside",
    );
    // Another terminal, whose leader is a person's shell: outside.
    const other = table([
      [1, 0, "Ss", "?"],
      [HOLDER, 1, "S", "?"],
      [AGENT, HOLDER, "Ss", "pts/7"],
      [810, 1, "Ss", "pts/8"],
      [811, 1, "S+", "pts/8"],
    ]);
    expect(insideSession({ pid: 811, sessions: [SESSION], view: view(other, IDS) })).toBe(
      "outside",
    );
    // A process on the same terminal that is not a leader of it does not make a session.
    const noLeader = table([
      [1, 0, "Ss", "?"],
      [AGENT, 1, "S", "pts/7"],
      [820, 1, "S+", "pts/7"],
    ]);
    expect(
      insideSession({ pid: 820, sessions: [{ child: SESSION.child }], view: view(noLeader, IDS) }),
    ).toBe("outside");
  });

  test("tA_inside_session_probe_tells_a_reused_pid", () => {
    // The holder's number was given to another process: its identity differs, so it is no holder.
    const rows = table([
      [1, 0, "Ss", "??"],
      [HOLDER, 1, "S", "??"],
      [900, HOLDER, "S", "??"],
    ]);
    const stranger = view(rows, { [HOLDER]: "someone else" });
    expect(insideSession({ pid: 900, sessions: [SESSION], view: stranger })).toBe("outside");
    // An identity that cannot be read now is taken for the record's: the guard refuses on a doubt.
    expect(insideSession({ pid: 900, sessions: [SESSION], view: view(rows) })).toBe("inside");
    // A record without an identity is matched by its pid.
    expect(
      insideSession({ pid: 900, sessions: [{ holder: { pid: HOLDER } }], view: stranger }),
    ).toBe("inside");
    // A parent chain that loops (a table read while it changed) ends.
    const loop = table([
      [900, 901, "S", "??"],
      [901, 900, "S", "??"],
    ]);
    expect(insideSession({ pid: 900, sessions: [SESSION], view: view(loop) })).toBe("outside");
  });

  test("tA_inside_session_probe_reads_the_records_of_the_state_base", () => {
    const base = mkdtempSync(join(tmpdir(), "kodel-guard-"));
    made.push(base);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const run = join(base, "run", String(uid));
    const put = (checkout: string, session: string, status: unknown) => {
      const dir = join(run, checkout, session);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "status.json"), JSON.stringify(status));
    };
    const running = {
      v: 1,
      state: "running",
      by: "holder",
      holder: { pid: HOLDER, identity: id("holder") },
      child: { pid: AGENT, identity: id("agent") },
      since: 1,
    };
    put("aaaa", "a_000000001_0000", running);
    // Another checkout of the same state base counts too; an ended session, a marker folder and a
    // record that cannot be read do not.
    put("bbbb", "a_000000002_0000", { ...running, holder: { pid: 520 }, child: { pid: 530 } });
    put("aaaa", "a_000000003_0000", { ...running, state: "exited", exitCode: 0 });
    put("aaaa.names", "a_000000004_0000", running);
    put("aaaa", "a_000000005_0000", { v: 99, state: "running" });
    mkdirSync(join(run, "aaaa", "a_000000006_0000"), { recursive: true });
    const found = runningSessions(base, uid);
    expect(found.map((s) => s.holder?.pid).sort()).toEqual([HOLDER, 520]);
    expect(found.map((s) => s.child?.pid).sort()).toEqual([AGENT, 530]);
    // A state base with no sessions, and one that is not there: nobody.
    expect(runningSessions(join(base, "none"))).toEqual([]);
    // A person's command is in none of them; a command under the recorded holder is, by the files.
    const rows = table([
      [1, 0, "Ss", "??"],
      [HOLDER, 1, "S", "??"],
      [600, HOLDER, "S", "??"],
      [700, 1, "Ss", "ttys001"],
    ]);
    expect(insideSessionOf(join(base, "none"), 700, view(rows, IDS))).toBe("outside");
    expect(insideSessionOf(base, 700, view(rows, IDS))).toBe("outside");
    expect(insideSessionOf(base, 600, view(rows, IDS))).toBe("inside");
    expect(insideSessionOf(join(base, "none"), 600, view(rows, IDS))).toBe("outside");
    expect(
      parseGuardRows(
        "  12   1 Ss   ttys001\n 13 12 S+ ??   node  a b  --kodel-session-holder \nnot a row\n",
      ),
    ).toEqual([
      { pid: 12, ppid: 1, state: "Ss", tty: "ttys001" },
      { pid: 13, ppid: 12, state: "S+", tty: "??", args: "node  a b  --kodel-session-holder" },
    ]);
  });
});
