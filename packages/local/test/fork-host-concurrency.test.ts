/**
 * Forks on the real host, commit 4 of T-40: the branches run at the same time, engine work never
 * runs under the run's lock, the snapshots a decision takes under it are bounded and never fatal,
 * waits are scoped to one node, and the shared working tree is said as a limit at a gate and at a
 * hand-in. The commands are ended by the test through the testkit's latch runner: no sleeps.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultHistory,
  type Effect,
  type PipelineHost,
  PipelineService,
  parsePipeline,
  TELL_CHANGES_NOTE,
} from "@kodel-ai/pipeline-core";
import { createLatchRunner, type LatchRunner } from "../../testkit/src/latch-runner";
import {
  DISPATCH_DEADLINE_MS,
  GitSnapshotter,
  LocalHost,
  type LocalRun,
  logVisitOf,
  SHARED_TREE_NOTE,
  SNAPSHOT_DEADLINE_MS,
  type WorkdirProvider,
} from "../src";
import type { CommandResult } from "../src/command";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-fork-conc-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Reference secret, assembled at run time so this file does not trip secret scanners.
const SECRET = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const runDir = (id: string) => join(dir, ".kodel", "runs", id);
const yaml = (lines: string[]) => `${lines.join("\n")}\n`;

/** Two command branches the test ends by hand (the latch runner), a join of the agent. */
const LATCHED = parsePipeline(
  yaml([
    "name: latched",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: a, kind: command, command: a }",
    "  - { slug: b, kind: command, command: b }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: merge }",
    "  - { from: a, to: merge, when: failed }",
    "  - { from: b, to: merge }",
    "  - { from: b, to: merge, when: failed }",
  ]),
);

/** Three command branches, for the heartbeats. */
const THREE = parsePipeline(
  yaml([
    "name: three",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: a, kind: command, command: a }",
    "  - { slug: b, kind: command, command: b }",
    "  - { slug: c, kind: command, command: c }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: plan, to: c }",
    "  - { from: a, to: merge }",
    "  - { from: a, to: merge, when: failed }",
    "  - { from: b, to: merge }",
    "  - { from: b, to: merge, when: failed }",
    "  - { from: c, to: merge }",
    "  - { from: c, to: merge, when: failed }",
  ]),
);

/** Three agent branches, for the hand-ins of a fork. */
const THREE_AGENTS = parsePipeline(
  yaml([
    "name: three-agents",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: a, kind: agent, prompt: a }",
    "  - { slug: b, kind: agent, prompt: b }",
    "  - { slug: c, kind: agent, prompt: c }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: plan, to: c }",
    "  - { from: a, to: merge }",
    "  - { from: b, to: merge }",
    "  - { from: c, to: merge }",
  ]),
);

/** Two agent branches. */
const AGENT_FORK = parsePipeline(
  yaml([
    "name: agents",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: a, kind: agent, prompt: do a }",
    "  - { slug: b, kind: agent, prompt: do b }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: merge }",
    "  - { from: b, to: merge }",
  ]),
);

/** An agent step with a command check in one branch, a held command in the other. */
const CHECKED = parsePipeline(
  yaml([
    "name: checked",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - slug: a",
    "    kind: agent",
    "    prompt: a",
    "    checks: [{ kind: command, command: a-check }]",
    "  - { slug: b, kind: command, command: b }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: merge }",
    "  - { from: b, to: merge }",
    "  - { from: b, to: merge, when: failed }",
  ]),
);

/** A gate in one branch, a held command in the other. */
const GATED = parsePipeline(
  yaml([
    "name: gated",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: a, kind: agent, prompt: a }",
    "  - { slug: a-gate, kind: human, prompt: a? }",
    "  - { slug: b, kind: command, command: b }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: a-gate }",
    "  - { from: a-gate, to: merge, when: approved }",
    "  - { from: a-gate, to: a, when: rejected }",
    "  - { from: b, to: merge }",
    "  - { from: b, to: merge, when: failed }",
  ]),
);

/** A `diff` check in each branch, and one at the join. */
const DIFFS = parsePipeline(
  yaml([
    "name: diffs",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - slug: a",
    "    kind: agent",
    "    prompt: a",
    '    checks: [{ kind: diff, paths: ["a.txt"], mode: changed_only }]',
    "  - slug: b",
    "    kind: agent",
    "    prompt: b",
    '    checks: [{ kind: diff, paths: ["b.txt"], mode: changed_only }]',
    "  - slug: merge",
    "    kind: agent",
    "    prompt: merge",
    "    join: all",
    '    checks: [{ kind: diff, paths: ["a.txt", "b.txt"], mode: changed_only, since: run }]',
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: merge }",
    "  - { from: a, to: merge, when: failed }",
    "  - { from: b, to: merge }",
    "  - { from: b, to: merge, when: failed }",
  ]),
);

/** A command branch with a `diff` check of its own (a snapshot at its entry) beside a plain one. */
const SNAPPED = parsePipeline(
  yaml([
    "name: snapped",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - slug: a",
    "    kind: command",
    "    command: a",
    '    checks: [{ kind: diff, paths: ["x.txt"], mode: changed }]',
    "  - { slug: b, kind: command, command: b }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: merge }",
    "  - { from: a, to: merge, when: failed }",
    "  - { from: b, to: merge }",
    "  - { from: b, to: merge, when: failed }",
  ]),
);

/** Resolves when `check` holds, or fails the test after `ms`: a regression fails instead of hanging. */
async function until(check: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("waited too long for it to happen");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Whether a promise settles within `ms`. */
const settlesWithin = (promise: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

/** Depth of the run's lock as this process holds it, how long each hold took, what started under it. */
function lockSpy() {
  let depth = 0;
  const underLock: string[] = [];
  const held: number[] = [];
  let since = 0;
  return {
    hooks: {
      entered: () => {
        depth += 1;
        since = Date.now();
      },
      left: () => {
        depth -= 1;
        held.push(Date.now() - since);
      },
    },
    depth: () => depth,
    underLock,
    held,
  };
}

describe("t40 the host runs the branches of a fork at the same time", () => {
  async function forkWith(
    spec = LATCHED,
    over: Record<string, unknown> = {},
  ): Promise<{
    h: LocalHost;
    run: LocalRun;
    latch: LatchRunner;
    spy: ReturnType<typeof lockSpy>;
  }> {
    const latch = createLatchRunner();
    const spy = lockSpy();
    const h = new LocalHost(spec, {
      root: dir,
      heartbeatMs: 0,
      runCommand: (command, options, context) => {
        // What the lock is doing when a command starts: engine work must never run under it.
        if (spy.depth() > 0) spy.underLock.push(context.node);
        return latch.runner(command, options, context);
      },
      lockHooks: spy.hooks,
      ...over,
    });
    const { run } = await h.start("split the work");
    await run.completeStep("plan", 1);
    return { h, run, latch, spy };
  }

  test("t40_host_runs_command_branches_concurrently", async () => {
    const { run, latch } = await forkWith();
    await latch.started("a#1");
    await latch.started("b#1");
    expect(latch.running().sort()).toEqual(["a#1", "b#1"]);
    expect((await run.state()).active.map((v) => [v.node, v.phase])).toEqual([
      ["a", "engine"],
      ["b", "engine"],
    ]);
    latch.release("b#1", 1, "b broke");
    await until(async () => (await run.state()).forks?.f1?.arrived.b !== undefined);
    expect(latch.running()).toEqual(["a#1"]);
    latch.release("a#1");
    await run.waitForRest(5_000);
    const state = await run.state();
    expect(state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(state.nodes.merge?.lastFailures?.map((f) => f.from)).toEqual(["b"]);
  });

  test("t40_journal_overlap_on_real_latch_run", async () => {
    const { h, run, latch } = await forkWith();
    await latch.started("a#1");
    await latch.started("b#1");
    latch.release("a#1");
    await until(async () => (await run.state()).forks?.f1?.arrived.a !== undefined);
    latch.release("b#1");
    await run.waitForRest(5_000);
    const events = (await h.store.readJournal(run.runId)).map(
      (r) => `${r.event}:${String(r.node ?? r.branch ?? "")}`,
    );
    // both branches were entered before either finished: that is the overlap, in the journal
    const entered = (node: string) => events.indexOf(`node_entered:${node}`);
    const finished = (node: string) => events.indexOf(`node_finished:${node}`);
    expect(entered("a")).toBeLessThan(finished("a"));
    expect(entered("b")).toBeLessThan(finished("a"));
    expect(entered("b")).toBeLessThan(finished("b"));
    expect(finished("a")).toBeLessThan(finished("b"));
    expect(events).toContain("fork_started:plan");
    expect(events.filter((e) => e.startsWith("branch_settled:"))).toEqual([
      "branch_settled:a",
      "branch_settled:b",
    ]);
  });

  test("t40_host_no_command_effect_under_lock", async () => {
    // without a snapshot in the decision, and with one (a `diff` check in a branch): the snapshot
    // is taken under the lock, the commands never start under it
    for (const spec of [LATCHED, SNAPPED]) {
      const { run, latch, spy } = await forkWith(spec);
      await latch.started("a#1");
      await latch.started("b#1");
      latch.release("a#1");
      latch.release("b#1");
      await run.waitForRest(5_000);
      // the lock was taken for every decision, and no command started while it was held
      expect(spy.held.length).toBeGreaterThan(3);
      expect(spy.underLock).toEqual([]);
      expect(spy.depth()).toBe(0);
      expect((await run.state()).active.map((v) => v.node)).toEqual(["merge"]);
    }
  });

  test("t40_host_snapshot_taken_before_commands_of_the_decision_start", async () => {
    // The baseline of a `diff` check is the tree at the decision that entered the node: the command
    // of that very decision must not run before the snapshot is taken, or its own writes would be in
    // the baseline and a `changed` check would see nothing changed.
    const order: string[] = [];
    class Watched extends GitSnapshotter {
      override async snapshot(...args: Parameters<GitSnapshotter["snapshot"]>): Promise<string> {
        order.push("snapshot:begin");
        const tree = await super.snapshot(...args);
        order.push("snapshot:end");
        return tree;
      }
    }
    const latch = createLatchRunner();
    const spy = lockSpy();
    const h = new LocalHost(SNAPPED, {
      root: dir,
      heartbeatMs: 0,
      snapshotter: new Watched(dir),
      lockHooks: spy.hooks,
      runCommand: async (command, options, context) => {
        if (spy.depth() > 0) spy.underLock.push(context.node);
        order.push(`command:${context.node}`);
        if (context.node === "a") await writeFile(join(dir, "x.txt"), "written by a\n");
        return latch.runner(command, options, context);
      },
    });
    const { run } = await h.start("split the work");
    await run.completeStep("plan", 1);
    await latch.started("a#1");
    await latch.started("b#1");
    const firstCommand = order.findIndex((e) => e.startsWith("command:"));
    expect(order.slice(0, firstCommand)).toContain("snapshot:end");
    expect(order.slice(firstCommand)).not.toContain("snapshot:begin");
    expect(spy.underLock).toEqual([]);
    latch.release("a#1");
    latch.release("b#1");
    await run.waitForRest(5_000);
    // the check compared against the tree before a's write: x.txt counts as changed
    const state = await run.state();
    expect(state.forks?.f1?.arrived.a).toMatchObject({ node: "a", label: "passed" });
    expect(state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(spy.underLock).toEqual([]);
    expect(spy.depth()).toBe(0);
  });

  test("t40_host_apply_not_blocked_by_running_command", async () => {
    const { run, latch } = await forkWith();
    await latch.started("a#1");
    await latch.started("b#1");
    // a decision while both commands run: it does not wait for them
    const noted = run.feedback({ category: "other", message: "while the branches run" });
    expect(await settlesWithin(noted, 2_000)).toBe(true);
    expect((await noted).ok).toBe(true);
    const looked = run.nextStep();
    expect(await settlesWithin(looked, 2_000)).toBe(true);
    expect("running" in (await looked)).toBe(true);
    latch.release("a#1");
    latch.release("b#1");
    await run.waitForRest(5_000);
  });

  test("t40_host_two_results_back_to_back_both_kept", async () => {
    const { h, run, latch } = await forkWith();
    await latch.started("a#1");
    await latch.started("b#1");
    // both commands end in the same tick: both results are applied, none is lost to the other
    latch.release("a#1");
    latch.release("b#1", 2);
    await run.waitForRest(5_000);
    const state = await run.state();
    expect(state.forks?.f1?.arrived.a).toMatchObject({ label: "passed" });
    expect(state.forks?.f1?.arrived.b).toMatchObject({ label: "failed" });
    expect(state.active.map((v) => v.node)).toEqual(["merge"]);
    const finished = (await h.store.readJournal(run.runId)).filter(
      (r) => r.event === "command_finished",
    );
    expect(finished.map((r) => [r.node, r.exit]).sort()).toEqual([
      ["a", 0],
      ["b", 2],
    ]);
  });

  test("t40_host_heartbeats_of_three_branches_drop_nothing", async () => {
    const { h, run, latch } = await forkWith(THREE, { heartbeatMs: 15 });
    for (const key of ["a#1", "b#1", "c#1"]) await latch.started(key);
    // the heartbeats of the three branches go on at once for a while
    await new Promise((resolve) => setTimeout(resolve, 150));
    const state = await run.state();
    expect(state.active.map((v) => v.node)).toEqual(["a", "b", "c"]);
    for (const visit of state.active) {
      expect(visit.owner).toBe(h.ownerId);
      expect(visit.heartbeatAt).toBeDefined();
      expect(visit.restarts).toBe(0);
    }
    for (const key of ["a#1", "b#1", "c#1"]) latch.release(key);
    await run.waitForRest(5_000);
    const after = await run.state();
    expect(after.active.map((v) => v.node)).toEqual(["merge"]);
    // every branch arrived once, and no heartbeat was mistaken for a lost one
    expect(Object.keys(after.forks?.f1?.arrived ?? {}).sort()).toEqual(["a", "b", "c"]);
    const journal = await h.store.readJournal(run.runId);
    expect(journal.filter((r) => r.event === "node_restarted")).toHaveLength(0);
    expect(journal.filter((r) => r.event === "command_finished")).toHaveLength(3);
  });

  test("t40_apply_queue_delay_bounded", async () => {
    // Many decisions in a burst while the branches run (heartbeats, ticks, notes of every branch):
    // each takes the lock once, none re-enters it, and each holds it for a bounded time. The
    // snapshots of a decision are the only slow thing under the lock, and this pipeline has none.
    const { run, latch, spy } = await forkWith();
    await latch.started("a#1");
    await latch.started("b#1");
    const before = spy.held.length;
    const burst = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? run.tick() : run.feedback({ category: "other", message: `note ${i}` }),
    );
    expect(await settlesWithin(Promise.all(burst), 10_000)).toBe(true);
    // one hold per decision (a tick that found nothing still takes it); none held twice over
    expect(spy.held.length - before).toBeGreaterThanOrEqual(30);
    expect(Math.max(...spy.held)).toBeLessThan(2_000);
    expect(spy.depth()).toBe(0);
    latch.release("a#1");
    latch.release("b#1");
    await run.waitForRest(5_000);
  });

  test("t40_complete_step_waits_only_for_own_checks", async () => {
    const { run, latch } = await forkWith(CHECKED);
    await latch.started("b#1");
    // the hand-in of `a` waits for a's own check and not for b, which is held
    latch.release("a#1#check0");
    const done = await run.completeStep("a", 1);
    expect(done.ok).toBe(true);
    const own = run.waitForRest(5_000, "a", "step");
    expect(await settlesWithin(own, 3_000)).toBe(true);
    const state = await run.state();
    expect(state.forks?.f1?.arrived.a).toMatchObject({ label: "passed" });
    expect(state.active.map((v) => [v.node, v.phase])).toEqual([["b", "engine"]]);
    // the whole run is still busy: a wait for all of it does not return while b runs
    expect(await settlesWithin(run.waitForRest(1_500), 1_000)).toBe(false);
    latch.release("b#1");
    await run.waitForRest(5_000);
    expect((await run.state()).active.map((v) => v.node)).toEqual(["merge"]);
  });

  test("t40_wait_scope_step_and_chain_differ", async () => {
    // a's check, then two commands in a row: `step` returns once a's own check is done, `chain`
    // waits for the commands a led into as well, both of them
    const chained = parsePipeline(
      yaml([
        "name: chained",
        "nodes:",
        "  - slug: a",
        "    kind: agent",
        "    prompt: a",
        "    checks: [{ kind: command, command: a-check }]",
        "  - { slug: c1, kind: command, command: c1 }",
        "  - { slug: c2, kind: command, command: c2 }",
        "  - { slug: end, kind: agent, prompt: end }",
        "edges:",
        "  - { from: a, to: c1 }",
        "  - { from: c1, to: c2 }",
        "  - { from: c2, to: end }",
        "  - { from: c1, to: end, when: failed }",
        "  - { from: c2, to: end, when: failed }",
      ]),
    );
    const latch = createLatchRunner();
    const h = new LocalHost(chained, { root: dir, heartbeatMs: 0, runCommand: latch.runner });
    const { run } = await h.start("one chain");
    latch.release("a#1#check0");
    expect((await run.completeStep("a", 1)).ok).toBe(true);
    expect(await settlesWithin(run.waitForRest(5_000, "a", "step"), 3_000)).toBe(true);
    await latch.started("c1#1");
    const chain = run.waitForRest(10_000, "a", "chain");
    expect(await settlesWithin(chain, 500)).toBe(false);
    latch.release("c1#1");
    await latch.started("c2#1");
    expect((await run.state()).active.map((v) => v.node)).toEqual(["c2"]);
    expect(await settlesWithin(chain, 500)).toBe(false);
    latch.release("c2#1");
    expect(await settlesWithin(chain, 5_000)).toBe(true);
    expect((await run.state()).active.map((v) => v.node)).toEqual(["end"]);
  });

  test("t40_fork_run_reopens_from_disk_mid_fork", async () => {
    const { run, latch } = await forkWith();
    await latch.started("a#1");
    await latch.started("b#1");
    // another host (another process, as far as the files go) opens the run as it stands
    const other = new LocalHost(LATCHED, { root: dir, heartbeatMs: 0 }).open(run.runId);
    const state = await other.state();
    expect(state.active.map((v) => [v.node, v.fork?.branch])).toEqual([
      ["a", "a"],
      ["b", "b"],
    ]);
    expect(state.forks?.f1).toMatchObject({ branches: ["a", "b"], arrived: {} });
    const step = await other.nextStep();
    expect("running" in step && step.running.active.map((v) => v.node_slug)).toEqual(["a", "b"]);
    // a tick from the other host does not take the work from a live owner
    await other.tick();
    expect((await other.state()).active.every((v) => v.restarts === 0)).toBe(true);
    latch.release("a#1");
    latch.release("b#1");
    await run.waitForRest(5_000);
    expect((await other.state()).active.map((v) => v.node)).toEqual(["merge"]);
  });

  test("t40_claim_survives_restart_of_host", async () => {
    const h = new LocalHost(AGENT_FORK, { root: dir, heartbeatMs: 0 });
    const { run } = await h.start("split the work");
    await run.completeStep("plan", 1);
    const took = await run.takeStep({ node: "a" });
    if (took.status !== "claimed") throw new Error(`expected claimed, got ${took.status}`);
    // the host is gone; a new one reads the claim from the state
    const again = new LocalHost(AGENT_FORK, { root: dir, heartbeatMs: 0 }).open(run.runId);
    const other = await again.takeStep({ node: "a" });
    expect(other.status).toBe("taken");
    const renewed = await again.takeStep({ node: "a", token: took.claim_token });
    expect(renewed.status).toBe("renewed");
    const free = await again.takeStep({});
    expect(free.status === "claimed" && free.step.slug).toBe("b");
  });

  test("t40_take_by_slug_under_the_cap_answers_queued", async () => {
    // `agents.max_parallel: 1`: with one step held, a take of another step by its slug gets `queued`
    // (no claim is written), not `taken` (nobody holds it); the holder renews its own all the same
    await mkdir(join(dir, ".kodel"), { recursive: true });
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      "worktree:\n  mode: off\nagents:\n  max_parallel: 1\n",
    );
    const h = new LocalHost(AGENT_FORK, { root: dir, heartbeatMs: 0 });
    const { run } = await h.start("split the work");
    await run.completeStep("plan", 1);
    const took = await run.takeStep({ node: "a" });
    if (took.status !== "claimed") throw new Error(`expected claimed, got ${took.status}`);
    const queued = await run.takeStep({ node: "b" });
    expect(queued).toEqual({
      status: "queued",
      node_slug: "b",
      attempt: 1,
      held: 1,
      max_parallel: 1,
    });
    expect((await run.state()).nodes.b?.claim).toBeUndefined();
    const any = await run.takeStep({});
    expect(any.status).toBe("none");
    expect(any.status === "none" && "running" in any.next && any.next.running.queued).toBe(1);
    expect((await run.takeStep({ node: "a", token: took.claim_token })).status).toBe("renewed");
    // through the service, as the tool answers
    const service = new PipelineService(h as unknown as PipelineHost);
    const answer = (await service.takeStep({ run_id: run.runId, node_slug: "b" })) as Record<
      string,
      unknown
    >;
    expect(answer.ok).toBe(true);
    expect(answer.status).toBe("queued");
    expect(String(answer.note)).toContain("max_parallel");
    // handed in: b is free to take
    await run.completeStep("a", 1, undefined, undefined, undefined, took.claim_token);
    expect((await run.takeStep({ node: "b" })).status).toBe("claimed");
  });

  test("t40_inspect_answers_with_the_agents_config_like_next_step", async () => {
    await mkdir(join(dir, ".kodel"), { recursive: true });
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      "worktree:\n  mode: off\nagents:\n  subagents: yes\n  max_parallel: 1\n",
    );
    const h = new LocalHost(AGENT_FORK, { root: dir, heartbeatMs: 0 });
    const { run } = await h.start("split the work");
    await run.completeStep("plan", 1);
    const seen = await run.inspect();
    const handed = await run.nextStep();
    if (!("node" in seen) || !("node" in handed)) throw new Error("expected node answers");
    expect(seen.node.steps?.map((s) => s.slug)).toEqual(handed.node.steps?.map((s) => s.slug));
    expect(seen.node.queued).toBe(1);
    expect(seen.node.execution?.mode).toBe(handed.node.execution?.mode);
  });

  test("t40_take_of_a_second_step_with_the_same_token_answers_that_step", async () => {
    const h = new LocalHost(AGENT_FORK, { root: dir, heartbeatMs: 0 });
    const { run } = await h.start("split the work");
    await run.completeStep("plan", 1);
    const took = await run.takeStep({ node: "a" });
    if (took.status !== "claimed") throw new Error(`expected claimed, got ${took.status}`);
    expect(took.step.slug).toBe("a");
    const second = await run.takeStep({ node: "b", token: took.claim_token });
    if (second.status !== "claimed") throw new Error(`expected claimed, got ${second.status}`);
    expect(second.step.slug).toBe("b");
    const again = await run.takeStep({ node: "b", token: took.claim_token });
    expect(again.status === "renewed" && again.step.slug).toBe("b");
  });

  test("t40_agent_log_prefers_agent_visit", async () => {
    const { run, latch } = await forkWith(CHECKED);
    await latch.started("b#1");
    const state = await run.state();
    // the agent step `a` is the first visit here; the command `b` runs beside it
    expect(state.active.map((v) => [v.node, v.phase])).toEqual([
      ["a", "agent"],
      ["b", "engine"],
    ]);
    expect(logVisitOf(state)).toEqual({ node: "a", attempt: 1 });
    // whatever the order of the visits, the agent's step is the one the log is booked to
    expect(logVisitOf({ ...state, active: [...state.active].reverse() })).toEqual({
      node: "a",
      attempt: 1,
    });
    // with no agent step open the first visit is booked, and with none the last node of the trail
    const engineOnly = state.active.filter((v) => v.node === "b");
    expect(logVisitOf({ ...state, active: engineOnly })).toEqual({ node: "b", attempt: 1 });
    expect(logVisitOf({ ...state, active: [] })).toEqual({ node: "b", attempt: 1 });
    latch.release("b#1");
    latch.release("a#1#check0");
    await run.completeStep("a", 1);
    await run.waitForRest(5_000);
  });

  test("t40_windows_concurrent_host_test", async () => {
    // Several hosts over one store (as several processes), each polling the run while two real
    // commands run at once: the lock file is taken and let go across them without an error, and the
    // run ends with every result kept. On Windows this is where a lock file a process holds would
    // fail to be removed by another; CI runs this file there.
    const real = parsePipeline(
      yaml([
        "name: real",
        "nodes:",
        "  - { slug: plan, kind: agent, prompt: plan }",
        `  - { slug: a, kind: command, command: "node -e \\"setTimeout(() => {}, 400)\\"" }`,
        `  - { slug: b, kind: command, command: "node -e \\"setTimeout(() => {}, 200); process.exitCode = 1\\"" }`,
        "  - { slug: merge, kind: agent, prompt: merge, join: all }",
        "edges:",
        "  - { from: plan, to: a }",
        "  - { from: plan, to: b }",
        "  - { from: a, to: merge }",
        "  - { from: a, to: merge, when: failed }",
        "  - { from: b, to: merge }",
        "  - { from: b, to: merge, when: failed }",
      ]),
    );
    const owner = new LocalHost(real, { root: dir, heartbeatMs: 20 });
    const { run } = await owner.start("split the work");
    await run.completeStep("plan", 1);
    const watchers = [1, 2, 3].map((i) =>
      new LocalHost(real, { root: dir, heartbeatMs: 0, ownerId: `watcher:${i}` }).open(run.runId),
    );
    const errors: unknown[] = [];
    const polls = watchers.map(async (watcher) => {
      for (let i = 0; i < 25; i++) {
        try {
          await watcher.nextStep();
          await watcher.tick();
        } catch (error) {
          errors.push(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });
    await Promise.all([...polls, run.waitForRest(10_000)]);
    expect(errors).toEqual([]);
    const state = await run.state();
    expect(state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(state.forks?.f1?.arrived.a).toMatchObject({ label: "passed" });
    expect(state.forks?.f1?.arrived.b).toMatchObject({ label: "failed" });
    const journal = await owner.store.readJournal(run.runId);
    expect(journal.filter((r) => r.event === "command_finished")).toHaveLength(2);
    // nothing was taken over from the live owner by the watchers' ticks
    expect(journal.filter((r) => r.event === "node_restarted")).toHaveLength(0);
  });
});

describe("t40 snapshots under the lock", () => {
  /** A snapshotter that counts its calls and can be made slow or broken. */
  class Counting extends GitSnapshotter {
    calls = 0;
    constructor(
      root: string,
      private readonly behave: "ok" | "slow" | "broken" = "ok",
    ) {
      super(root);
    }
    override async snapshot(deadline?: { remainingMs(): number }): Promise<string> {
      this.calls += 1;
      if (this.behave === "broken") throw new Error("git is broken");
      if (this.behave === "slow") {
        // Takes as long as it is allowed, then gives up: what a hung git looks like to the host.
        while ((deadline?.remainingMs() ?? 0) > 0) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error("deadline: git took longer than the time allowed");
      }
      return super.snapshot(deadline);
    }
  }

  test("t40_host_one_snapshot_per_fork", async () => {
    const snapshotter = new Counting(dir);
    const h = new LocalHost(DIFFS, { root: dir, heartbeatMs: 0, snapshotter });
    const { run } = await h.start("split the work");
    const beforeFork = snapshotter.calls;
    await run.completeStep("plan", 1);
    // the fork asks for the baseline of each branch's `diff` check: one tree, stored under both keys
    expect(snapshotter.calls - beforeFork).toBe(1);
    const snapshots = await h.store.readSnapshots(run.runId);
    expect(snapshots["visit:2"]).toBeDefined();
    expect(snapshots["visit:3"]).toBe(snapshots["visit:2"]);
  });

  test("t40_host_apply_delay_bounded_with_slow_snapshot", async () => {
    // A snapshot that hangs holds the lock no longer than its deadline, the branches start all the
    // same, and the baselines are recorded as missing.
    const snapshotter = new Counting(dir, "slow");
    const spy = lockSpy();
    const h = new LocalHost(DIFFS, {
      root: dir,
      heartbeatMs: 0,
      snapshotter,
      snapshotDeadlineMs: 100,
      dispatchDeadlineMs: 250,
      lockHooks: spy.hooks,
    });
    const { run } = await h.start("split the work");
    const begun = Date.now();
    const done = await run.completeStep("plan", 1);
    expect(done.ok).toBe(true);
    expect(Date.now() - begun).toBeLessThan(2_000);
    expect(Math.max(...spy.held)).toBeLessThan(1_000);
    const state = await run.state();
    expect(state.active.map((v) => v.node)).toEqual(["a", "b"]);
    const snapshots = await h.store.readSnapshots(run.runId);
    expect(snapshots["visit:2"]).toBeUndefined();
    expect(String(snapshots["visit:2!"])).toContain("deadline");
    expect(String(snapshots["visit:3!"])).toContain("deadline");
    // the defaults stay far below the time after which a lock counts as abandoned
    expect(SNAPSHOT_DEADLINE_MS).toBeLessThan(60_000);
    expect(DISPATCH_DEADLINE_MS).toBeLessThan(60_000);
    expect(SNAPSHOT_DEADLINE_MS).toBeLessThanOrEqual(DISPATCH_DEADLINE_MS);
  });

  test("t40_dispatch_total_bound_marks_remaining_snapshots_unavailable", async () => {
    // The bound of the whole decision is spent: nothing is taken, and every key the decision asked
    // for (the baselines of the branches, and the gate's tree) says why.
    const h = new LocalHost(DIFFS, {
      root: dir,
      heartbeatMs: 0,
      snapshotter: new Counting(dir),
      dispatchDeadlineMs: 0,
    });
    const { run } = await h.start("split the work");
    await run.completeStep("plan", 1);
    const snapshots = await h.store.readSnapshots(run.runId);
    for (const key of ["visit:2", "visit:3"]) {
      expect(snapshots[key]).toBeUndefined();
      expect(String(snapshots[`${key}!`])).toContain("ran out");
    }
    // a gate reached under the same bound says it cannot tell what changed, never "nothing changed"
    const gated = new LocalHost(GATED, {
      root: dir,
      heartbeatMs: 0,
      snapshotter: new Counting(dir),
      dispatchDeadlineMs: 0,
      runCommand: createLatchRunner().runner,
    });
    const started = await gated.start("gate under the bound");
    await started.run.completeStep("plan", 1);
    await started.run.completeStep("a", 1);
    const found = await started.run.changesSinceGate("a-gate");
    expect(found.kind).toBe("unavailable");
    expect(found.kind === "unavailable" && found.reason).toContain("ran out");
  });

  test("t40_gate_is_repo_question_bounded_by_dispatch_deadline", async () => {
    // A gate alone asks git only whether the directory is a repository. That question is asked
    // under the lock, so a hung git there is held to the bound of the decision like a snapshot is.
    class Hanging extends GitSnapshotter {
      armed = false;
      asked: (number | undefined)[] = [];
      override async isRepo(timeoutMs?: number): Promise<boolean> {
        if (!this.armed) return super.isRepo(timeoutMs);
        this.asked.push(timeoutMs);
        await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs ?? 5_000, 5_000)));
        throw new Error("deadline: git took longer than the time allowed");
      }
    }
    const snapshotter = new Hanging(dir);
    const spy = lockSpy();
    const history = defaultHistory();
    history.changes.enabled = false;
    history.executor.enabled = false;
    const h = new LocalHost(GATED, {
      root: dir,
      heartbeatMs: 0,
      snapshotter,
      dispatchDeadlineMs: 250,
      lockHooks: spy.hooks,
      runCommand: createLatchRunner().runner,
    });
    const { run } = await h.start("a gate under the bound", { history });
    await run.completeStep("plan", 1);
    snapshotter.armed = true;
    const begun = Date.now();
    expect((await run.completeStep("a", 1)).ok).toBe(true);
    expect(Date.now() - begun).toBeLessThan(2_000);
    expect(Math.max(...spy.held)).toBeLessThan(1_000);
    expect(snapshotter.asked.length).toBeGreaterThan(0);
    for (const timeout of snapshotter.asked) expect(timeout).toBeLessThanOrEqual(250);
    expect((await run.state()).active.map((v) => v.node)).toEqual(["b", "a-gate"]);
    const found = await run.changesSinceGate("a-gate");
    expect(found.kind).toBe("unavailable");
    expect(found.kind === "unavailable" && found.reason).toContain("deadline");
  });

  test("t40_diff_check_after_failed_snapshot_fails_branch", async () => {
    const h = new LocalHost(DIFFS, {
      root: dir,
      heartbeatMs: 0,
      snapshotter: new Counting(dir, "broken"),
    });
    const { run } = await h.start("split the work");
    await run.completeStep("plan", 1);
    await writeFile(join(dir, "a.txt"), "a\n");
    const done = await run.completeStep("a", 1);
    expect(done.ok).toBe(true);
    await run.waitForRest(5_000, "a");
    // the baseline is missing: the check fails the step and says so; the other branch is untouched
    const state = await run.state();
    expect(state.nodes.a?.lastFailure?.reason).toContain("there is no snapshot");
    expect(state.forks?.f1?.arrived.a).toMatchObject({ label: "failed" });
    expect(state.active.map((v) => [v.node, v.phase])).toEqual([["b", "agent"]]);
  });

  test("t40_diff_check_in_fork_sees_sibling_write_join_checks_carry_verdict", async () => {
    // The branches share one tree: a's `changed_only a.txt` sees b.txt too and fails, and so does
    // b's; both arrive failed, and the join's own check over both files is what passes.
    const h = new LocalHost(DIFFS, { root: dir, heartbeatMs: 0 });
    const { run } = await h.start("split the work");
    await run.completeStep("plan", 1);
    await writeFile(join(dir, "a.txt"), "a\n");
    await writeFile(join(dir, "b.txt"), "b\n");
    await run.completeStep("a", 1);
    await run.waitForRest(5_000, "a");
    expect((await run.state()).nodes.a?.lastFailure?.reason).toContain("b.txt");
    await run.completeStep("b", 1);
    await run.waitForRest(5_000, "b");
    const state = await run.state();
    expect(state.forks?.f1?.arrived.a).toMatchObject({ label: "failed" });
    expect(state.forks?.f1?.arrived.b).toMatchObject({ label: "failed" });
    expect(state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(state.nodes.merge?.lastFailures?.map((f) => f.from)).toEqual(["a", "b"]);
    await run.completeStep("merge", 1);
    await run.waitForRest(5_000);
    expect((await run.state()).status).toBe("completed");
    const report = await run.report();
    expect(report.failed_branches).toBe(true);
    expect(report.forks[0]?.failed).toEqual(["a", "b"]);
  });
});

describe("t40 the shared tree at a gate and at a hand-in", () => {
  const latched = async (spec: ReturnType<typeof parsePipeline>) => {
    const latch = createLatchRunner();
    const history = defaultHistory();
    history.executor.enabled = false;
    const h = new LocalHost(spec, { root: dir, heartbeatMs: 0, runCommand: latch.runner });
    const { run } = await h.start("split the work", { history });
    return { h, run, latch };
  };

  test("t40_gate_note_when_other_branches_active", async () => {
    const { run, latch } = await latched(GATED);
    await run.completeStep("plan", 1);
    await latch.started("b#1");
    await run.completeStep("a", 1);
    await run.waitForRest(5_000, "a");
    await writeFile(join(dir, "shared.txt"), "written while the gate waits\n");
    // the gate's list of changes carries the note while b runs
    const found = await run.changesSinceGate("a-gate");
    expect(found).toMatchObject({ kind: "changes", note: SHARED_TREE_NOTE });
    const step = await run.nextStep();
    expect("waiting" in step && step.waiting.node_slug).toBe("a-gate");
    expect("waiting" in step && step.waiting.changes_note).toBe(SHARED_TREE_NOTE);
    // and still after b has arrived: it was active while the gate waited
    latch.release("b#1");
    await run.waitForRest(5_000, "b");
    expect((await run.state()).active.map((v) => v.node)).toEqual(["a-gate"]);
    expect(await run.changesSinceGate("a-gate")).toMatchObject({ note: SHARED_TREE_NOTE });
    const again = await run.nextStep();
    expect("waiting" in again && again.waiting.changes_note).toBe(SHARED_TREE_NOTE);
  });

  test("t40_worker_answer_gets_no_person_text_from_the_host", async () => {
    // the gate waits while b runs: the coordinator is told to pass the note on; a worker keeps the
    // note as data but is told only to report back
    const { run, latch } = await latched(GATED);
    await run.completeStep("plan", 1);
    await latch.started("b#1");
    await run.completeStep("a", 1);
    await run.waitForRest(5_000, "a");
    const coordinator = await run.nextStep();
    if (!("waiting" in coordinator)) throw new Error("expected a waiting answer");
    expect(coordinator.waiting.tell_the_person).toContain(TELL_CHANGES_NOTE);
    const worker = await run.nextStep({ worker: true });
    if (!("waiting" in worker)) throw new Error("expected a waiting answer");
    expect(worker.waiting.changes_note).toBe(SHARED_TREE_NOTE);
    expect(worker.waiting.tell_the_person).toContain("You are a worker");
    expect(worker.waiting.tell_the_person).not.toContain(TELL_CHANGES_NOTE);
    latch.release("b#1");
    await run.waitForRest(5_000);
  });

  test("t40_gate_note_uses_the_gate_visits_real_attempt", async () => {
    // the gate is on its second attempt (rejected once) and the other branch has arrived meanwhile:
    // the note on the answer and the one of `changesSinceGate` are both there, from the same attempt
    const { run, latch } = await latched(GATED);
    await run.completeStep("plan", 1);
    await latch.started("b#1");
    await run.completeStep("a", 1);
    await run.waitForRest(5_000, "a");
    await run.decideHuman("a-gate", "rejected", "again");
    await run.completeStep("a", 2);
    await run.waitForRest(5_000, "a");
    latch.release("b#1");
    await run.waitForRest(5_000, "b");
    const state = await run.state();
    expect(state.active.map((v) => [v.node, v.attempt])).toEqual([["a-gate", 2]]);
    const step = await run.nextStep();
    expect("waiting" in step && step.waiting.attempt).toBe(2);
    expect("waiting" in step && step.waiting.changes_note).toBe(SHARED_TREE_NOTE);
    expect(await run.changesSinceGate("a-gate")).toMatchObject({ note: SHARED_TREE_NOTE });
  });

  test("t40_host_labels_a_result_with_the_effects_spec", async () => {
    // the label of a result is the version on the effect, not the run's version read when the job
    // starts: a change accepted in between that leaves the node alone must not make it stale
    const { run, latch } = await latched(GATED);
    const inner = run as unknown as { spawn(effect: Effect): void };
    const spawn = inner.spawn.bind(run);
    inner.spawn = (effect: Effect) => {
      spawn(effect.type === "run_command" ? { ...effect, spec: "issued-under" } : effect);
    };
    const labels: (string | undefined)[] = [];
    const apply = run.apply.bind(run);
    run.apply = (event, options) => {
      if (event.type === "work_finished") labels.push(event.specHash);
      return apply(event, options);
    };
    await run.completeStep("plan", 1);
    await latch.started("b#1");
    latch.release("b#1");
    for (let i = 0; i < 100 && labels.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(labels).toEqual(["issued-under"]);
    run.stop();
  });

  test("t40_gate_answer_note_covers_the_window_of_its_list", async () => {
    // b writes and arrives at the join before a reaches its gate: the gate's own window holds none
    // of b's moves, but the answer's list (the whole run) holds b's file, so the note is there too
    const { run, latch } = await latched(GATED);
    await run.completeStep("plan", 1);
    await latch.started("b#1");
    await writeFile(join(dir, "out.txt"), "written by b\n");
    latch.release("b#1");
    await run.waitForRest(5_000, "b");
    await run.completeStep("a", 1);
    await run.waitForRest(5_000, "a");
    const state = JSON.parse(JSON.stringify(await run.state())) as Awaited<
      ReturnType<typeof run.state>
    >;
    expect(state.active.map((v) => v.node)).toEqual(["a-gate"]);
    const step = await run.nextStep();
    if (!("waiting" in step)) throw new Error("expected a waiting answer");
    expect(step.waiting.changes).toMatchObject({ "out.txt": 1 });
    expect(step.waiting.changes_note).toBe(SHARED_TREE_NOTE);
    expect(step.waiting.tell_the_person).toContain("`changes_note`");
  });

  test("t40_no_gate_note_when_alone", async () => {
    const alone = parsePipeline(
      yaml([
        "name: alone",
        "nodes:",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: a-gate, kind: human, prompt: a? }",
        "edges:",
        "  - { from: a, to: a-gate }",
        "  - { from: a-gate, to: a, when: rejected }",
      ]),
    );
    const { run } = await latched(alone);
    await run.completeStep("a", 1);
    await writeFile(join(dir, "mine.txt"), "the agent's own write\n");
    const found = await run.changesSinceGate("a-gate");
    expect(found.kind).toBe("changes");
    expect(found).not.toHaveProperty("note");
    const step = await run.nextStep();
    expect("waiting" in step && step.waiting.changes).toEqual({ "mine.txt": 1 });
    expect("waiting" in step && step.waiting).not.toHaveProperty("changes_note");
  });

  test("t40_hand_in_backoff_not_applied_in_open_fork", async () => {
    // Every snapshot of a hand-in runs out of time. Alone, two such hand-ins switch the patches off
    // for the rest of the run (`skipped:`); while another branch is active the hand-in is still tried,
    // and its record says the tree was shared.
    class Slow extends GitSnapshotter {
      override async snapshot(): Promise<string> {
        throw new Error(
          "deadline: git took longer than the time allowed for recording the changes",
        );
      }
    }
    const history = defaultHistory();
    history.executor.enabled = false;
    const h = new LocalHost(THREE_AGENTS, {
      root: dir,
      heartbeatMs: 0,
      snapshotter: new Slow(dir),
    });
    const { run } = await h.start("split the work", { history });
    const handIn = async (node: string) => {
      const done = await run.completeStep(node, 1);
      expect(done.ok).toBe(true);
      await run.waitForRest(5_000, node);
      const record = (await h.store.readJournal(run.runId)).findLast(
        (r) => r.event === "agent_completed" && r.node === node,
      );
      return { error: String(record?.changes_error ?? ""), note: record?.changes_note };
    };
    expect(await handIn("plan")).toMatchObject({ error: expect.stringMatching(/^deadline:/) });
    expect((await run.state()).active.map((v) => v.node)).toEqual(["a", "b", "c"]);
    // two hand-ins ran out of time; the third is in a fork with siblings active: still tried
    expect(await handIn("a")).toMatchObject({
      error: expect.stringMatching(/^deadline:/),
      note: SHARED_TREE_NOTE,
    });
    expect(await handIn("b")).toMatchObject({
      error: expect.stringMatching(/^deadline:/),
      note: SHARED_TREE_NOTE,
    });
    // the last branch is alone now, but its siblings worked in the tree since it was entered: still
    // tried, with the note (their writes are in its patch)
    expect(await handIn("c")).toMatchObject({
      error: expect.stringMatching(/^deadline:/),
      note: SHARED_TREE_NOTE,
    });
    // the join stands alone and nothing of another branch moved since it was entered: the back-off
    // applies as it does without a fork, and no note
    const last = await handIn("merge");
    expect(last.error).toMatch(/^skipped:/);
    expect(last.note).toBeUndefined();
  });

  test("t40_hand_in_note_when_a_sibling_wrote_and_arrived_before_it", async () => {
    // b writes a file and arrives while a's step is open; when a hands in, nothing else is active,
    // but b's write is in a's patch all the same: the record says the tree was shared
    const { h, run, latch } = await latched(GATED);
    await run.completeStep("plan", 1);
    await latch.started("b#1");
    await writeFile(join(dir, "b.txt"), "written by b\n");
    latch.release("b#1");
    await run.waitForRest(5_000, "b");
    expect((await run.state()).active.map((v) => v.node)).toEqual(["a"]);
    await run.completeStep("a", 1);
    await run.waitForRest(5_000, "a");
    const record = (await h.store.readJournal(run.runId)).findLast(
      (r) => r.event === "agent_completed" && r.node === "a",
    );
    expect(record?.changes_note).toBe(SHARED_TREE_NOTE);
    // a step alone in its run has no note: plan was handed in with nothing else going on
    const plan = (await h.store.readJournal(run.runId)).find(
      (r) => r.event === "agent_completed" && r.node === "plan",
    );
    expect(plan?.changes_note).toBeUndefined();
  });

  test("t40_redact_also_waiting_text", async () => {
    // A branch pauses with a failure whose reason holds a secret the command printed: the pause is
    // named to the agent working the other branch (`also_waiting`, the note), and nothing of the
    // secret reaches that text or any file of the run.
    const paused = parsePipeline(
      yaml([
        "name: paused",
        "nodes:",
        "  - { slug: plan, kind: agent, prompt: plan }",
        "  - { slug: a, kind: agent, prompt: a }",
        `  - { slug: b, kind: command, command: "node -e \\"console.log('token ${SECRET} leaked'); process.exit(1)\\"", max_attempts: 1, max_consecutive_failures: 1 }`,
        `  - { slug: b-fix, kind: command, command: "node -e \\"process.exit(1)\\"" }`,
        "  - { slug: merge, kind: agent, prompt: merge, join: all }",
        "edges:",
        "  - { from: plan, to: a }",
        "  - { from: plan, to: b }",
        "  - { from: a, to: merge }",
        "  - { from: b, to: merge }",
        "  - { from: b, to: b-fix, when: failed }",
        "  - { from: b-fix, to: merge }",
        "  - { from: b-fix, to: b, when: failed }",
      ]),
    );
    const h = new LocalHost(paused, { root: dir, heartbeatMs: 0 });
    const { run } = await h.start("split the work");
    await run.completeStep("plan", 1);
    await run.waitForRest(10_000, "b");
    await run.waitForRest(10_000, "b-fix");
    const state = await run.state();
    expect(state.status).toBe("running");
    expect(state.pauses.map((p) => [p.reason, p.node])).toEqual([["consecutive", "b"]]);
    const step = await run.nextStep();
    if (!("node" in step)) throw new Error("expected the step of a");
    const also = step.node.also_waiting ?? [];
    expect(also.map((w) => [w.reason, w.node_slug])).toEqual([["paused", "b"]]);
    const text = `${JSON.stringify(also)} ${step.node.note ?? ""}`;
    expect(text).toContain("[REDACTED");
    expect(text).not.toContain(SECRET);
    expect(text).toContain(`kodel resume ${run.runId}`);
    for (const file of (await readdir(runDir(run.runId), { recursive: true })).filter((f) =>
      /\.(json|jsonl)$/.test(f),
    )) {
      expect(await readFile(join(runDir(run.runId), file), "utf8"), file).not.toContain(SECRET);
    }
  });

  test("t40_every_written_string_is_clean", async () => {
    // A secret is planted in every text a fork run composes new fields from: the task (rendered
    // into the prompts the answers carry), a note, a summary, a command's output (the failed
    // branch's reason: `branch_settled`, the join's feedbacks), a person's rejection (the restarted
    // branch's feedback), a completion by a stranger (`step_claim_conflict`), and the reason of a
    // run that fails on a dead branch. No file of the run and no answer carries it.
    const clean = parsePipeline(
      yaml([
        "name: clean",
        "nodes:",
        "  - { slug: plan, kind: agent, prompt: 'plan {{task}}' }",
        "  - { slug: a, kind: agent, prompt: 'a {{task}}' }",
        "  - { slug: a-gate, kind: human, prompt: 'a done for {{task}}?' }",
        "  - { slug: b, kind: command, command: b }",
        "  - { slug: merge, kind: agent, prompt: 'merge {{task}}', join: all }",
        "edges:",
        "  - { from: plan, to: a }",
        "  - { from: plan, to: b }",
        "  - { from: a, to: a-gate }",
        "  - { from: a-gate, to: merge, when: approved }",
        "  - { from: a-gate, to: a, when: rejected }",
        "  - { from: b, to: merge }",
        "  - { from: b, to: merge, when: failed }",
      ]),
    );
    // the validator refuses a command branch with no way on for its failure; the state can still
    // get there (a kept pipeline), so the spec is built from a valid one with that edge taken out
    const routed = parsePipeline(
      yaml([
        "name: doomed",
        "nodes:",
        "  - { slug: plan, kind: agent, prompt: plan }",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: c, kind: command, command: c }",
        "  - { slug: merge, kind: agent, prompt: merge, join: all }",
        "edges:",
        "  - { from: plan, to: a }",
        "  - { from: plan, to: c }",
        "  - { from: a, to: merge }",
        "  - { from: c, to: merge }",
        "  - { from: c, to: merge, when: failed }",
      ]),
    );
    const doomed = {
      ...routed,
      edges: routed.edges.filter((e) => !(e.from === "c" && e.when === "failed")),
    };
    const calls = new Map<string, number>();
    const runCommand = async (
      _command: string,
      _options: unknown,
      context: { node: string },
    ): Promise<CommandResult> => {
      const n = (calls.get(context.node) ?? 0) + 1;
      calls.set(context.node, n);
      // b fails once and passes when `restart_failed` runs it again; c (no way on) fails for good
      const fails = context.node === "c" || n === 1;
      return {
        exit: fails ? 1 : 0,
        timedOut: false,
        aborted: false,
        tail: fails ? `${context.node} said: key ${SECRET} rejected\n` : "",
        truncated: false,
        durationMs: 1,
      };
    };
    const answers: unknown[] = [];
    const say = <T>(value: T): T => {
      answers.push(value);
      return value;
    };
    const h = new LocalHost(clean, { root: dir, heartbeatMs: 0, runCommand });
    const { run } = await h.start(`split the work (key ${SECRET})`, { history: defaultHistory() });
    say(await run.nextStep());
    say(await run.feedback({ category: "other", message: `note ${SECRET}`, node: "plan" }));
    say(await run.completeStep("plan", 1, `planned with ${SECRET}`));
    await run.waitForRest(10_000, "b");
    expect((await run.state()).forks?.f1?.arrived.b).toMatchObject({ label: "failed" });
    const token = say(await run.takeStep({ node: "a" }));
    if (token.status !== "claimed") throw new Error("expected the claim");
    say(await run.nextStep());
    // a stranger completes a's step: the conflict is journaled, the completion counts
    say(await run.completeStep("a", 1, `did a ${SECRET}`, undefined, undefined, "not-the-token"));
    await run.waitForRest(10_000, "a");
    say(await run.nextStep());
    say(await run.decideHuman("a-gate", "rejected", `no: ${SECRET} is in the diff`));
    const again = say(await run.nextStep());
    expect("node" in again && again.node.reentry_feedback).toContain("[REDACTED");
    say(await run.completeStep("a", 2, "took it out"));
    await run.waitForRest(10_000, "a");
    say(await run.decideHuman("a-gate", "approved"));
    const atJoin = say(await run.nextStep());
    expect("node" in atJoin && atJoin.node.slug).toBe("merge");
    expect("node" in atJoin && atJoin.node.reentry_feedback).toContain("[REDACTED");
    say(await run.completeStep("merge", 1, `fixed ${SECRET}`, "restart_failed"));
    await run.waitForRest(10_000);
    say(await run.completeStep("merge", 2, "all green"));
    await run.waitForRest(10_000);
    const state = await run.state();
    expect(state.status).toBe("completed");
    say(await run.nextStep());
    say(state);
    say(await run.report());

    // a run that ends failed on a dead branch, with the branch's reason in the run's reason
    const g = new LocalHost(doomed, { root: dir, heartbeatMs: 0, runCommand });
    const dead = await g.start(`doomed work (key ${SECRET})`);
    say(await dead.run.completeStep("plan", 1, `planned ${SECRET}`));
    await dead.run.waitForRest(10_000, "c");
    say(await dead.run.completeStep("a", 1));
    await dead.run.waitForRest(10_000);
    const ended = await dead.run.state();
    expect(ended.status).toBe("failed");
    say(await dead.run.nextStep());
    say(ended);
    say(await dead.run.report());

    const text = JSON.stringify(answers);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[REDACTED");
    for (const id of [run.runId, dead.run.runId]) {
      const files = await readdir(runDir(id), { recursive: true });
      expect(files.length).toBeGreaterThan(3);
      for (const file of files) {
        const path = join(runDir(id), file);
        if (!(await lstat(path)).isFile()) continue;
        expect(await readFile(path, "utf8"), `${id}/${file}`).not.toContain(SECRET);
      }
    }
    // the fields were really written from the planted texts
    const journal = await h.store.readJournal(run.runId);
    const of = (event: string) => journal.filter((r) => r.event === event);
    expect(JSON.stringify(of("feedback_reported"))).toContain("[REDACTED");
    expect(JSON.stringify(of("branch_settled"))).toContain("[REDACTED");
    expect(JSON.stringify(of("gate_decided"))).toContain("[REDACTED");
    expect(JSON.stringify(of("join_reached")[0])).toContain("[REDACTED");
    expect(of("step_claim_conflict")).toHaveLength(1);
    expect(JSON.stringify(state.forks?.f1?.arrived)).not.toContain("[REDACTED"); // b passed in the end
    expect(JSON.stringify(of("agent_completed").map((r) => r.summary))).toContain("[REDACTED");
    const finished = (await g.store.readJournal(dead.run.runId)).find(
      (r) => r.event === "run_finished",
    );
    expect(String(finished?.reason)).toContain('branch "c" failed at "c"');
    expect(String(finished?.reason)).toContain("[REDACTED");
  });
});

describe("t40 a scoped wait takes over only its own work", () => {
  /** Branch a: an agent step, then a command; branch b: a command. */
  const OWN_CHAIN = parsePipeline(
    yaml([
      "name: own-chain",
      "nodes:",
      "  - { slug: plan, kind: agent, prompt: plan }",
      "  - { slug: a, kind: agent, prompt: a }",
      "  - { slug: a-slow, kind: command, command: a-slow }",
      "  - { slug: b, kind: command, command: b }",
      "  - { slug: merge, kind: agent, prompt: merge, join: all }",
      "edges:",
      "  - { from: plan, to: a }",
      "  - { from: plan, to: b }",
      "  - { from: a, to: a-slow }",
      "  - { from: a-slow, to: merge }",
      "  - { from: a-slow, to: merge, when: failed }",
      "  - { from: b, to: merge }",
      "  - { from: b, to: merge, when: failed }",
    ]),
  );

  test("t40_scoped_wait_never_takes_over_a_sibling_command", async () => {
    // b was started by a process that is gone; a-slow, in a's chain, runs in another live process.
    // A wait scoped to a (what `kodel gate` and the others do) watches a-slow on disk and ticks now
    // and then; the tick must not take b over: b would start in the waiting process, be left out of
    // its wait, and be lost with the exit that follows.
    const alive = (owner: string) => owner !== "gone";
    const hostAs = (ownerId: string, latch: LatchRunner) =>
      new LocalHost(OWN_CHAIN, {
        root: dir,
        heartbeatMs: 0,
        ownerId,
        isOwnerAlive: alive,
        runCommand: latch.runner,
      });
    const latch0 = createLatchRunner();
    const { run: run0 } = await hostAs("gone", latch0).start("split the work");
    await run0.completeStep("plan", 1);
    await latch0.started("b#1");
    run0.stop();
    const latch1 = createLatchRunner();
    const run1 = hostAs("other", latch1).open(run0.runId);
    await run1.completeStep("a", 1);
    await latch1.started("a-slow#1");
    const latch2 = createLatchRunner();
    const run2 = hostAs("waiter", latch2).open(run0.runId);
    // longer than the rounds after which the wait ticks
    await run2.waitForRest(1_800, "a");
    expect(latch2.seen()).toEqual([]);
    const state = await run2.state();
    expect(state.active.map((v) => [v.node, v.owner]).sort()).toEqual([
      ["a-slow", "other"],
      ["b", "gone"],
    ]);
    expect((await run2.journal()).filter((r) => r.event === "node_restarted")).toEqual([]);
    // an unscoped wait (nobody's in particular) takes the orphan over, as before
    await run2.tick();
    await latch2.started("b#1");
    latch2.release("b#1");
    latch1.release("a-slow#1");
    await run1.waitForRest(5_000);
    await run2.waitForRest(5_000);
  }, 20_000);
});

describe("t40 git under the lock is bounded (seventh review)", () => {
  /** A worktree provider whose check of the directory hangs once armed: a hung git behind `cwd`. */
  class HangingWorkdirs implements WorkdirProvider {
    armed = false;
    async prepare() {
      return { path: dir, created: false };
    }
    async verify() {
      if (this.armed) await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    async discard() {}
  }

  test("t40_dispatch_bounds_finding_the_directory", async () => {
    const workdirs = new HangingWorkdirs();
    const spy = lockSpy();
    const h = new LocalHost(DIFFS, {
      root: dir,
      heartbeatMs: 0,
      workdirs,
      snapshotter: new GitSnapshotter(dir),
      dispatchDeadlineMs: 250,
      lockHooks: spy.hooks,
    });
    const history = defaultHistory();
    history.changes.enabled = false;
    history.executor.enabled = false;
    const { run } = await h.start("split the work", { history });
    workdirs.armed = true;
    spy.held.length = 0;
    expect((await run.completeStep("plan", 1)).ok).toBe(true);
    // the check of the directory hangs, under the lock and before it alike: the lock is not held
    // past the bound of the decision
    expect(Math.max(...spy.held)).toBeLessThan(1_000);
    const snapshots = await h.store.readSnapshots(run.runId);
    expect(String(snapshots["visit:2!"])).toContain("ran out");
    expect(String(snapshots["visit:3!"])).toContain("ran out");
  });

  test("t40_run_facts_bounded_and_left_out_when_late", async () => {
    const one = parsePipeline(
      yaml(["name: one", "nodes:", "  - { slug: plan, kind: agent, prompt: plan }", "edges: []"]),
    );
    const finish = async (runFactsDeadlineMs?: number) => {
      const h = new LocalHost(one, {
        root: dir,
        heartbeatMs: 0,
        ...(runFactsDeadlineMs === undefined ? {} : { runFactsDeadlineMs }),
      });
      const { run } = await h.start(`finish ${runFactsDeadlineMs ?? "default"}`);
      expect((await run.completeStep("plan", 1)).ok).toBe(true);
      await run.waitForRest(5_000);
      const journal = await h.store.readJournal(run.runId);
      return journal.find((r) => r.event === "run_finished");
    };
    // with time to read it, the run's end names HEAD; with none, the facts are left out and the
    // run still ends
    expect((await finish())?.head).toBeString();
    const late = await finish(0);
    expect(late).toMatchObject({ status: "completed" });
    expect(late?.head).toBeUndefined();
  });

  test("t40_gate_beside_a_check_without_git_is_no_repo", async () => {
    // One decision enters a node with a `diff` baseline and reaches a gate, in a directory without
    // git: the check's baseline is recorded as missing, the gate has nothing to compare and says so.
    const bare = await mkdtemp(join(tmpdir(), "kodel-no-git-"));
    try {
      const spec = parsePipeline(
        yaml([
          "name: both",
          "nodes:",
          "  - { slug: plan, kind: agent, prompt: plan }",
          "  - { slug: g, kind: human, prompt: g? }",
          "  - slug: c",
          "    kind: agent",
          "    prompt: c",
          '    checks: [{ kind: diff, paths: ["c.txt"], mode: changed_only }]',
          "  - { slug: merge, kind: agent, prompt: merge, join: all }",
          "edges:",
          "  - { from: plan, to: g }",
          "  - { from: plan, to: c }",
          "  - { from: g, to: merge, when: approved }",
          "  - { from: g, to: merge, when: rejected }",
          "  - { from: c, to: merge }",
          "  - { from: c, to: merge, when: failed }",
        ]),
      );
      // git answers "a repository" once, to let the run start (a change of its pipeline could add
      // the check later just the same), and "none" from then on
      class Gone extends GitSnapshotter {
        asked = 0;
        override async isRepo(): Promise<boolean> {
          this.asked += 1;
          return this.asked === 1;
        }
      }
      const h = new LocalHost(spec, { root: bare, heartbeatMs: 0, snapshotter: new Gone(bare) });
      const { run } = await h.start("both at once");
      await run.completeStep("plan", 1);
      expect((await run.state()).active.map((v) => v.node).sort()).toEqual(["c", "g"]);
      const snapshots = await h.store.readSnapshots(run.runId);
      expect(Object.keys(snapshots).filter((k) => k.startsWith("gate:"))).toEqual([]);
      expect(Object.keys(snapshots).some((k) => k.startsWith("visit:") && k.endsWith("!"))).toBe(
        true,
      );
      expect(await run.changesSinceGate("g")).toEqual({ kind: "no_repo" });
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
