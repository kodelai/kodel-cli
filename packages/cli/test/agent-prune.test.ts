/**
 * `kodel agent prune` (T-45): what it never removes, that it asks once, and that it reads each record
 * again before it removes it. The rule and the command run over a fake adapter; the rows about the
 * adapter's own refusal, the name markers and a resume in progress run on the real one with real
 * (pipes) sessions.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipesSessionAdapter, type StartOptions } from "@kodel-ai/local";
import type { RunState, SessionListEntry, SessionSpec } from "@kodel-ai/pipeline-core";
import type { AgentContext, AgentHost, AgentProject, AgentSessions } from "../src/agent-commands";
import { pruneKeeps, runAgentPrune, runOfRecord } from "../src/agent-prune";
import { FakeSessions } from "./fake-sessions";

const DAY = 24 * 3_600_000;
const NOW = 100 * DAY;
const RUN = "r_0mw53d7fj_o2lc";

class Refused extends Error {}

interface Harness {
  out: string;
  asked: string[];
  hostReads: number;
}

function world(
  sessions: AgentSessions,
  options: {
    runs?: Record<string, RunState["status"] | "unreadable">;
    failRuns?: boolean;
    confirm?: boolean;
    onConfirm?: () => void;
  } = {},
) {
  const seen: Harness = { out: "", asked: [], hostReads: 0 };
  const ctx: AgentContext = {
    cwd: "/proj",
    out: (text) => {
      seen.out += text;
    },
    environment: {},
    root: async () => "/proj",
    fail: (message: string): never => {
      throw new Refused(message);
    },
    requireHuman() {},
    mustConfirm: async (question) => {
      seen.asked.push(question);
      options.onConfirm?.();
      if (options.confirm === false) throw new Refused("not confirmed, nothing was changed");
    },
    now: () => NOW,
  };
  const host = {
    async runSummaries() {
      seen.hostReads += 1;
      if (options.failRuns) throw new Error("the runs cannot be read");
      return Object.entries(options.runs ?? {}).map(([runId, status]) =>
        status === "unreadable"
          ? { meta: { runId }, state: undefined, unreadable: { code: "CANNOT_READ" } }
          : { meta: { runId }, state: { status } as RunState },
      );
    },
  } as unknown as AgentHost;
  const project = { root: "/proj", version: "test", host: async () => host } as AgentProject;
  const prune = (flags: { olderThan?: string; dryRun?: boolean } = {}) =>
    runAgentPrune({ ctx, sessions, project }, flags);
  return { seen, prune };
}

const done = (id: string, over: Partial<SessionListEntry> = {}): SessionListEntry => ({
  id,
  mode: "pipes",
  status: { state: "exited", exitCode: 0, since: NOW - 10 * DAY },
  ...over,
});

const rule = { now: NOW, olderThanMs: 0, runEnd: () => "unknown" as const };

describe("t45 kodel agent prune: what stays", () => {
  test("t45_prune_keeps_live", async () => {
    const sessions = new FakeSessions();
    sessions.add(done("a_000000001_live", { status: { state: "running" } }));
    sessions.add(done("a_000000002_strt", { status: { state: "starting" } }));
    sessions.add(done("a_000000003_done"));
    const { seen, prune } = world(sessions);
    await prune();
    expect(sessions.removed).toEqual(["a_000000003_done"]);
    expect(seen.out).not.toContain("a_000000001_live");
    expect(seen.out).not.toContain("a_000000002_strt");
    expect(pruneKeeps(done("x", { status: { state: "running" } }), rule)).toBe("runs");
  });

  test("t45_prune_keeps_unreadable", async () => {
    const sessions = new FakeSessions();
    for (const problem of ["CANNOT_READ", "FOREIGN", "NEWER_FORMAT"] as const) {
      sessions.add({ id: `a_00000000${problem.length}_prob`, status: { state: "lost" }, problem });
    }
    const { seen, prune } = world(sessions);
    await prune();
    expect(sessions.removed).toEqual([]);
    expect(seen.out).toBe("nothing to remove\n");
    expect(seen.asked).toEqual([]);
    expect(sessions.calls.filter((c) => c.startsWith("remove"))).toEqual([]);
  });

  test("t45_prune_keeps_open_run", async () => {
    for (const status of ["running", "paused"] as const) {
      const sessions = new FakeSessions();
      sessions.add(done("a_000000001_kw00", { name: `kw-${RUN}` }));
      sessions.add(done("a_000000002_kwd0", { name: `kw-${RUN}-d17` }));
      sessions.add(done("a_000000003_ke00", { name: `ke-${RUN}-3-1` }));
      const { seen, prune } = world(sessions, { runs: { [RUN]: status } });
      await prune();
      expect(sessions.removed, status).toEqual([]);
      expect(seen.out, status).toBe("nothing to remove\n");
    }
    // The same records once the run has ended: they go, and the runs were read once.
    for (const status of ["completed", "failed", "canceled"] as const) {
      const sessions = new FakeSessions();
      sessions.add(done("a_000000001_kw00", { name: `kw-${RUN}` }));
      sessions.add(done("a_000000002_kwd0", { name: `kw-${RUN}-d17` }));
      sessions.add(done("a_000000003_ke00", { name: `ke-${RUN}-3-1` }));
      const { seen, prune } = world(sessions, { runs: { [RUN]: status } });
      await prune();
      expect(sessions.removed.length, status).toBe(3);
      expect(seen.hostReads, status).toBe(1);
    }
    expect(runOfRecord(`kw-${RUN}`)).toBe(RUN);
    expect(runOfRecord(`kw-${RUN}-d3`)).toBe(RUN);
    expect(runOfRecord(`ke-${RUN}-3-1`)).toBe(RUN);
    expect(runOfRecord("cc")).toBeUndefined();
    expect(runOfRecord(undefined)).toBeUndefined();
  });

  test("t45_prune_keeps_unknown_run", async () => {
    const rows = () => {
      const sessions = new FakeSessions();
      sessions.add(done("a_000000001_kw00", { name: `kw-${RUN}` }));
      sessions.add(done("a_000000003_ke00", { name: `ke-${RUN}-3-1` }));
      return sessions;
    };
    // The run cannot be read; the run is not among the runs; the runs cannot be read at all.
    const cases: Parameters<typeof world>[1][] = [
      { runs: { [RUN]: "unreadable" } },
      { runs: {} },
      { failRuns: true },
    ];
    for (const options of cases) {
      const sessions = rows();
      const { seen, prune } = world(sessions, options);
      await prune();
      expect(sessions.removed).toEqual([]);
      expect(seen.out).toBe("nothing to remove\n");
    }
    // A listing with no record of a run does not read the runs.
    const plain = new FakeSessions();
    plain.add(done("a_000000009_done", { name: "cc" }));
    const { seen, prune } = world(plain, { failRuns: true });
    await prune();
    expect(seen.hostReads).toBe(0);
    expect(plain.removed).toEqual(["a_000000009_done"]);
  });

  test("t45_prune_keeps_younger_than_the_bound", async () => {
    const sessions = new FakeSessions();
    sessions.add(done("a_000000001_old0", { status: { state: "exited", since: NOW - 8 * DAY } }));
    sessions.add(done("a_000000002_new0", { status: { state: "exited", since: NOW - 6 * DAY } }));
    sessions.add(
      done("a_000000003_edge", {
        status: { state: "killed", reason: "stopped", since: NOW - 7 * DAY },
      }),
    );
    const { prune } = world(sessions);
    await prune({ olderThan: "7" });
    expect(sessions.removed.sort()).toEqual(["a_000000001_old0", "a_000000003_edge"]);
    expect((await sessions.list()).map((row) => row.id)).toEqual(["a_000000002_new0"]);
    // Without the flag every finished record goes; a bound that is no number is refused.
    const { prune: all } = world(sessions);
    await all();
    expect(sessions.removed).toContain("a_000000002_new0");
    for (const bad of ["soon", "-1"]) {
      await expect(world(sessions).prune({ olderThan: bad })).rejects.toThrow(
        "--older-than is a number of days",
      );
    }
  });

  test("t45_prune_keeps_a_record_whose_child_runs", async () => {
    const sessions = new FakeSessions();
    sessions.add(
      done("a_000000001_lost", {
        status: { state: "lost", reason: "holder_gone", childAlive: true },
      }),
    );
    sessions.add(
      done("a_000000002_kill", {
        status: { state: "killed", reason: "holder_error", childAlive: true },
      }),
    );
    const { seen, prune } = world(sessions);
    await prune();
    expect(sessions.removed).toEqual([]);
    expect(seen.out).toBe("nothing to remove\n");
    expect(pruneKeeps(done("x", { status: { state: "lost", childAlive: true } }), rule)).toBe(
      "its process still runs",
    );
  });
});

describe("t45 kodel agent prune: how it removes", () => {
  test("t45_prune_confirms_once", async () => {
    const sessions = new FakeSessions();
    for (const n of [1, 2, 3]) sessions.add(done(`a_00000000${n}_done`));
    // `--dry-run` asks nothing and removes nothing.
    const dry = world(sessions);
    await dry.prune({ dryRun: true });
    expect(dry.seen.asked).toEqual([]);
    expect(sessions.removed).toEqual([]);
    expect(dry.seen.out).toContain("would remove 3 finished agents; nothing was removed\n");
    for (const n of [1, 2, 3]) expect(dry.seen.out).toContain(`a_00000000${n}_done`);
    // Not confirmed: nothing goes.
    const no = world(sessions, { confirm: false });
    await expect(no.prune()).rejects.toThrow("not confirmed");
    expect(sessions.removed).toEqual([]);
    // One question, with the count, for all of them.
    const yes = world(sessions);
    await yes.prune();
    expect(yes.seen.asked).toEqual(["Remove 3 finished agents?"]);
    expect(sessions.removed.length).toBe(3);
    expect(yes.seen.out).toContain("removed 3 of 3\n");
    const one = new FakeSessions();
    one.add(done("a_000000001_done"));
    const single = world(one);
    await single.prune();
    expect(single.seen.asked).toEqual(["Remove 1 finished agent?"]);
  });

  test("t45_prune_reads_again_before_each_removal", async () => {
    const sessions = new FakeSessions();
    sessions.add(done("a_000000001_done"));
    sessions.add(done("a_000000002_wake"));
    sessions.add(done("a_000000003_gone"));
    // While the question stands, one record comes alive and one is removed by somebody else.
    const { seen, prune } = world(sessions, {
      onConfirm() {
        const woke = sessions.rows.find((row) => row.id === "a_000000002_wake");
        if (woke) woke.status = { state: "running" };
        sessions.rows = sessions.rows.filter((row) => row.id !== "a_000000003_gone");
      },
    });
    await prune();
    expect(sessions.removed).toEqual(["a_000000001_done"]);
    expect(seen.out).toContain("a_000000002_wake: kept (runs)\n");
    expect(seen.out).toContain("removed 1 of 3\n");
    // One listing, for the question; then each record alone, by its id, before its removal.
    expect(sessions.calls.filter((c) => c === "list").length).toBe(1);
    expect(sessions.calls.filter((c) => c.startsWith("status"))).toEqual([
      "status a_000000001_done",
      "status a_000000002_wake",
      "status a_000000003_gone",
    ]);
    expect(sessions.calls.filter((c) => c.startsWith("remove"))).toEqual([
      "remove a_000000001_done",
    ]);
  });

  test("t45_prune_says_which_conversations_could_be_continued", async () => {
    const sessions = new FakeSessions();
    const claude = { engine: "claude", session: "0f4b1c2d-0000-4000-8000-000000000001" };
    sessions.add(done("a_000000001_conv", { name: "cc", mode: "pty", agent: claude }));
    sessions.add(done("a_000000002_conv", { mode: "pty", agent: claude }));
    // No terminal, no conversation id, the agent of a run: nothing `--resume` could continue.
    sessions.add(done("a_000000003_pipe", { name: "pp", agent: claude }));
    sessions.add(
      done("a_000000004_noid", { name: "nn", mode: "pty", agent: { engine: "claude" } }),
    );
    sessions.add(done("a_000000005_kw00", { name: `kw-${RUN}`, mode: "pty", agent: claude }));
    const warning =
      "kodel agent start --resume could still continue the conversation of cc, a_000000002_conv; not once their records are removed\n";
    const dry = world(sessions, { runs: { [RUN]: "completed" } });
    await dry.prune({ dryRun: true });
    expect(dry.seen.out).toContain(warning);
    const yes = world(sessions, { runs: { [RUN]: "completed" } });
    await yes.prune();
    expect(yes.seen.out).toContain(warning);
    expect(yes.seen.asked).toEqual([
      "Remove 5 finished agents (2 with a conversation that could be continued)?",
    ]);
    expect(sessions.removed.length).toBe(5);
    // One of them, and none: the words fit, and the question is the plain one.
    const one = new FakeSessions();
    one.add(done("a_000000001_conv", { name: "cc", mode: "pty", agent: claude }));
    const single = world(one);
    await single.prune();
    expect(single.seen.out).toContain(
      "could still continue the conversation of cc; not once its record is removed\n",
    );
    expect(single.seen.asked).toEqual([
      "Remove 1 finished agent (1 with a conversation that could be continued)?",
    ]);
    const none = new FakeSessions();
    none.add(done("a_000000003_pipe", { name: "pp", agent: claude }));
    const plainOne = world(none);
    await plainOne.prune();
    expect(plainOne.seen.out).not.toContain("--resume");
    expect(plainOne.seen.asked).toEqual(["Remove 1 finished agent?"]);
  });
});

describe("t45 kodel agent prune on the real adapter", () => {
  const entry = join(import.meta.dir, "../../local/src/session-holder-entry.ts");
  const made: string[] = [];
  let adapter: PipesSessionAdapter;
  let root: string;
  let base: string | undefined;
  /** The first call makes the place and the adapter of the test; a later one is another starter of it. */
  const make = (over: Partial<ConstructorParameters<typeof PipesSessionAdapter>[0]> = {}) => {
    const first = base === undefined;
    if (base === undefined) {
      base = mkdtempSync(join(tmpdir(), "kodel-prune-base-"));
      root = mkdtempSync(join(tmpdir(), "kodel-prune-root-"));
      made.push(base, root);
    }
    const built = new PipesSessionAdapter({
      base,
      root,
      holder: { exec: process.execPath, args: [entry, "holder"] },
      intermediate: { exec: process.execPath, args: [entry] },
      pollMs: 50,
      ...over,
    });
    if (first) adapter = built;
    return built;
  };
  afterEach(async () => {
    for (const row of await adapter.list().catch(() => [])) {
      await adapter.stop(row.id).catch(() => {});
    }
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
    base = undefined;
  });
  const sh = (script: string, extra: Record<string, unknown> = {}) => ({
    argv: ["sh", "-c", script],
    cwd: root,
    timeoutMs: 30_000,
    ...extra,
  });
  const names = () => readdirSync(adapter.place.namesDir).sort();

  test("t45_prune_remove_refuses_a_live_record", async () => {
    make();
    const live = await adapter.start(sh("sleep 30", { name: "live", origin: "cli" }));
    const over = await adapter.start(sh("exit 0", { name: "over", origin: "cli" }));
    await adapter.wait(over.id, { timeoutMs: 15_000 });
    // What the command reads says the live one is finished (it went live after the last read):
    // `remove` itself is what refuses it.
    const stale: AgentSessions = {
      capabilities: () => adapter.capabilities(),
      start: (spec: SessionSpec, options?: StartOptions) => adapter.start(spec, options),
      status: async (id) =>
        id === live.id ? { state: "exited" as const, exitCode: 0 } : adapter.status(id),
      wait: (id, opts) => adapter.wait(id, opts),
      tail: (id, bytes, stream) => adapter.tail(id, bytes, stream),
      stop: (id) => adapter.stop(id),
      remove: (id) => adapter.remove(id),
      list: async () =>
        (await adapter.list()).map((row) =>
          row.id === live.id ? { ...row, status: { state: "exited" as const, exitCode: 0 } } : row,
        ),
    };
    const { seen, prune } = world(stale);
    await prune();
    expect(seen.out).toContain(`${live.id}: kept (STILL_RUNNING: session ${live.id} still runs`);
    expect(seen.out).toContain("removed 1 of 2\n");
    expect((await adapter.list()).map((row) => row.id)).toEqual([live.id]);
    expect(names()).toEqual(["live.json"]);
  }, 60_000);

  test("t45_prune_frees_cli_names_and_keeps_host_markers", async () => {
    make();
    const mine = await adapter.start(sh("exit 0", { name: "mine", origin: "cli" }));
    const step = await adapter.start(sh("exit 0", { name: "step-1", origin: "host" }));
    await adapter.wait(mine.id, { timeoutMs: 15_000 });
    await adapter.wait(step.id, { timeoutMs: 15_000 });
    expect(names()).toEqual(["mine.json", "step-1.json"]);
    const { seen, prune } = world(adapter);
    await prune();
    expect(seen.out).toContain("removed 2 of 2\n");
    expect(await adapter.list()).toEqual([]);
    // The person's name is free again; the host's stays used (its retry rule needs that).
    expect(names()).toEqual(["step-1.json"]);
    const again = await adapter.start(sh("exit 0", { name: "mine", origin: "cli" }));
    expect(again.id).not.toBe(mine.id);
  }, 60_000);

  test("t45_prune_during_a_resume", async () => {
    make();
    const old = await adapter.start(sh("exit 0", { name: "cc", origin: "cli" }));
    await adapter.wait(old.id, { timeoutMs: 15_000 });
    const marker = () =>
      JSON.parse(readFileSync(join(adapter.place.namesDir, "cc.json"), "utf8")) as { id: string };
    // A resume is at the point where its new record exists and the name is about to move. A removal
    // of the old record right there is refused (a failed resume gives the name back to it), and a
    // prune that runs from there on never removes the record the name is moving to.
    let atClaim: Promise<unknown> | undefined;
    let pruning: Promise<string> | undefined;
    const resuming = make({
      testHooks: {
        afterPublish() {
          atClaim = adapter.remove(old.id).then(
            () => "removed",
            (error: unknown) => error,
          );
          const { seen, prune } = world(adapter);
          pruning = prune().then(() => seen.out);
        },
      },
    });
    const next = await resuming.start(
      sh("sleep 30", {
        name: "cc",
        origin: "cli",
        agent: {
          engine: "claude",
          session: "0f4b1c2d-0000-4000-8000-000000000003",
          resumes: old.id,
        },
      }),
      { takeName: old.id },
    );
    expect(await atClaim).toMatchObject({ code: "STILL_RUNNING" });
    const printed = await pruning;
    expect(printed).not.toContain(next.id);
    const left = (await adapter.list()).map((row) => row.id);
    expect(left).toContain(next.id);
    expect(marker().id).toBe(next.id);
    // The old record may go once the name has moved; the name stays with the new one.
    const { prune } = world(adapter);
    await prune();
    expect((await adapter.list()).map((row) => row.id)).toEqual([next.id]);
    expect(marker().id).toBe(next.id);
    expect(names()).toEqual(["cc.json"]);
  }, 60_000);
});
