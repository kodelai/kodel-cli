import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRecord } from "@kodel-ai/pipeline-core";
import {
  hostSessionOfGroup,
  insideHostSession,
  ownProcessGroup,
  parseProcStatGroup,
  parsePsGroup,
} from "../src/process-group";
import { processIdentity } from "../src/process-table";
import { ensurePrivateDir, sessionPlace } from "../src/session-paths";
import { PipesSessionAdapter } from "../src/session-pipes";
import { publishSession, replaceRecord } from "../src/session-records";

const entry = join(import.meta.dir, "../src/session-holder-entry.ts");
const posix = process.platform !== "win32";
// A sandbox that forbids `ps` (and has no /proc) cannot read a group; CI sets KODEL_REQUIRE_PROCTABLE=1.
const groupReadable = ownProcessGroup() !== undefined;
const realTest = test.skipIf(
  !posix || (!groupReadable && process.env.KODEL_REQUIRE_PROCTABLE !== "1"),
);
const made: string[] = [];

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const eventually = async (check: () => Promise<boolean>, ms = 8_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition not reached");
};

/** Reads the group of another process the way `ownProcessGroup` reads its own. */
const groupOf = (pid: number): number | undefined =>
  ownProcessGroup({
    pid,
    readProcStat: () => {
      try {
        return readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch {
        return undefined;
      }
    },
  });

describe("T-42: kodel mcp inside an engine step serves no tools", () => {
  test("t42_the_real_tests_run_or_the_guard_says_why_not", () => {
    // Where the group can be read, the real tests below run and it is this process's own group, as
    // `ps` or /proc tell it for this pid; where it cannot, the guard fails open and says so.
    if (groupReadable) {
      expect(groupOf(process.pid)).toBe(ownProcessGroup() as number);
    } else {
      const guard = insideHostSession({}, { base: temp("kdpg-base-") });
      expect(guard).toMatchObject({ inside: false });
      expect(guard.reason).toContain("cannot be read");
    }
  });

  realTest(
    "t42_engine_child_is_not_a_second_kodel_client",
    async () => {
      const base = temp("kdpg-base-");
      const root = temp("kdpg-root-");
      const adapter = new PipesSessionAdapter({
        base,
        root,
        holder: { exec: process.execPath, args: [entry, "holder"] },
        intermediate: { exec: process.execPath, args: [entry] },
        pollMs: 50,
      });
      // A descendant of the child (as `kodel mcp` is, under the agent's CLI) prints its pid and stays.
      const { id } = await adapter.start({
        argv: ["sh", "-c", "sleep 30 & echo pid=$!; wait"],
        cwd: root,
        timeoutMs: 20_000,
        origin: "host",
      });
      try {
        let grandchild = 0;
        await eventually(async () => {
          const match = /pid=(\d+)/.exec((await adapter.tail(id)).text);
          if (match?.[1]) grandchild = Number(match[1]);
          return grandchild > 0;
        });
        const status = JSON.parse(readFileSync(join(adapter.place.dir, id, "status.json"), "utf8"));
        const pgid = groupOf(grandchild);
        expect(pgid).toBe(status.child.pid);
        expect(hostSessionOfGroup(base, pgid as number)).toBe(id);
        // The test's own group is not the session's.
        expect(insideHostSession({}, { base })).toEqual({ inside: false });
        await adapter.stop(id);
        expect(hostSessionOfGroup(base, pgid as number)).toBeUndefined();
      } finally {
        await adapter.stop(id).catch(() => {});
      }
    },
    20_000,
  );

  test("t42_proc_stat_group_is_read_after_the_last_paren", () => {
    const line = "4242 (my (odd) name) S 100 777 777 0 -1 4194560 120 0 0 0 1 0 0 0 20 0 1 0 5 0\n";
    expect(parseProcStatGroup(line)).toBe(777);
    expect(
      ownProcessGroup({ platform: "linux", readProcStat: () => line, runPs: () => undefined }),
    ).toBe(777);
    expect(parseProcStatGroup("garbage")).toBeUndefined();
  });

  test("t42_ps_group_output_is_parsed", () => {
    expect(parsePsGroup("  555\n")).toBe(555);
    expect(parsePsGroup("PGID\n")).toBeUndefined();
    expect(ownProcessGroup({ platform: "darwin", runPs: () => " 31337\n" })).toBe(31337);
    // Linux falls back to ps when /proc cannot be read.
    expect(
      ownProcessGroup({ platform: "linux", readProcStat: () => undefined, runPs: () => "88\n" }),
    ).toBe(88);
  });

  test("t42_ps_failure_fails_open", () => {
    const base = temp("kdpg-base-");
    for (const platform of ["linux", "darwin"] as const) {
      const guard = insideHostSession(
        {},
        { base, platform, readProcStat: () => undefined, runPs: () => undefined },
      );
      expect(guard.inside).toBe(false);
      expect(guard.reason).toContain("cannot be read");
    }
  });

  const writeSession = (base: string, root: string, id: string, origin: "cli" | "host") => {
    const place = sessionPlace({ base, root });
    ensurePrivateDir(place.runDir);
    ensurePrivateDir(place.dir);
    publishSession(join(place.dir, id), {
      v: 1,
      id,
      mode: "pipes",
      spec: { cwd: root, envNames: [], origin, timeoutMs: 10_000 },
      started: Date.now(),
      root,
    });
    const identity = processIdentity(process.pid);
    replaceRecord(
      join(place.dir, id, "status.json"),
      encodeRecord("status", {
        v: 1,
        state: "running",
        by: "holder",
        holder: { pid: process.pid },
        child: { pid: process.pid, ...(identity ? { identity } : {}) },
        since: Date.now(),
      }),
    );
  };

  test("t42_child_home_that_differs_does_not_hide_the_session", () => {
    // The session is recorded under the account's own base; the child sees another home (its HOME, which
    // `os.homedir()` reads, is injected as `home`: the test's own HOME is never looked at).
    const account = temp("kdpg-home-");
    const other = temp("kdpg-other-");
    const root = temp("kdpg-root-");
    const base = join(account, ".kodel");
    writeSession(base, root, "a_000000000_0hh1", "host");
    const asGroup = {
      runPs: () => `${process.pid}\n`,
      readProcStat: () => undefined,
      alive: () => true,
      accountHome: () => account,
      home: () => other,
    };
    // under a holder (KODEL_ENGINE=1) the account's base is looked in too: inside
    expect(insideHostSession({ KODEL_ENGINE: "1" }, asGroup)).toEqual({
      inside: true,
      session: "a_000000000_0hh1",
    });
    // without it, only the base of the environment is: the variable widens the look, nothing more
    expect(insideHostSession({}, asGroup)).toEqual({ inside: false });
    // and it never decides alone: a process outside the session's group keeps its tools
    expect(insideHostSession({ KODEL_ENGINE: "1" }, { ...asGroup, runPs: () => "1\n" })).toEqual({
      inside: false,
    });
  });

  realTest(
    "t42_child_home_that_differs_real",
    async () => {
      // A real host session; the guard reads the group of the session's grandchild with ps or /proc,
      // seeing another home than the one the session was recorded under (injected, as the child's HOME).
      const account = temp("kdpg-home-");
      const base = join(account, ".kodel");
      const root = temp("kdpg-root-");
      const adapter = new PipesSessionAdapter({
        base,
        root,
        holder: { exec: process.execPath, args: [entry, "holder"] },
        intermediate: { exec: process.execPath, args: [entry] },
        pollMs: 50,
      });
      const { id } = await adapter.start({
        argv: ["sh", "-c", "sleep 30 & echo pid=$!; wait"],
        cwd: root,
        timeoutMs: 20_000,
        origin: "host",
      });
      try {
        let grandchild = 0;
        await eventually(async () => {
          const match = /pid=(\d+)/.exec((await adapter.tail(id)).text);
          if (match?.[1]) grandchild = Number(match[1]);
          return grandchild > 0;
        });
        const guard = insideHostSession(
          { KODEL_ENGINE: "1" },
          {
            home: () => temp("kdpg-other-"),
            pid: grandchild,
            readProcStat: () => {
              try {
                return readFileSync(`/proc/${grandchild}/stat`, "utf8");
              } catch {
                return undefined;
              }
            },
            accountHome: () => account,
          },
        );
        expect(guard).toEqual({ inside: true, session: id });
      } finally {
        await adapter.stop(id).catch(() => {});
      }
    },
    20_000,
  );

  test.skipIf(!posix)("t42_cli_origin_session_keeps_tools", () => {
    const base = temp("kdpg-base-");
    const root = temp("kdpg-root-");
    const asGroup = { base, runPs: () => `${process.pid}\n`, readProcStat: () => undefined };
    writeSession(base, root, "a_000000000_00c1", "cli");
    expect(insideHostSession({}, asGroup)).toEqual({ inside: false });
    // The same records with `origin: "host"` are an engine step's session.
    writeSession(base, root, "a_000000000_00h1", "host");
    expect(insideHostSession({}, asGroup)).toEqual({ inside: true, session: "a_000000000_00h1" });
  });
});
