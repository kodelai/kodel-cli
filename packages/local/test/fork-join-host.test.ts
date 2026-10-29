/**
 * Forks on the real host (T-40): what reaches the disk goes through redaction, and the records a run
 * writes carry run-state format 2 while the other records keep their own versions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AGENTS,
  defaultHistory,
  KodelError,
  type PipelineHost,
  PipelineService,
  parsePipeline,
  RECORD_VERSION,
} from "@kodel-ai/pipeline-core";
import {
  hashSource,
  LocalHost,
  LocalPipelineHost,
  type LocalRun,
  loadConfig,
  META_VERSION,
} from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-fork-host-"));
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

/** Two command branches; `b` prints a secret and fails, and its failure arrives at the join. */
const FORK = parsePipeline(
  [
    "name: fork",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    `  - { slug: a, kind: command, command: "node -e \\"console.log('a ok')\\"" }`,
    `  - { slug: b, kind: command, command: "node -e \\"console.log('token ${SECRET} leaked'); process.exit(1)\\"" }`,
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: merge }",
    "  - { from: a, to: merge, when: failed }",
    "  - { from: b, to: merge }",
    "  - { from: b, to: merge, when: failed }",
    "",
  ].join("\n"),
);

const host = () => new LocalHost(FORK, { root: dir, heartbeatMs: 0 });
const runDir = (id: string) => join(dir, ".kodel", "runs", id);

describe("t40 forks on the host", () => {
  test("t40_host_fork_records_are_redacted_and_carry_format_2", async () => {
    const h = host();
    const { run } = await h.start("split the work");
    await run.completeStep("plan", 1);
    await run.waitForRest(10_000);
    const state = await run.state();
    expect(state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(state.forks?.f1?.arrived.b).toMatchObject({ node: "b", label: "failed" });
    const journal = await h.store.readJournal(run.runId);
    expect(journal.map((r) => r.event)).toContain("fork_started");
    expect(journal.map((r) => r.event)).toContain("join_reached");

    // the secret the command printed is in no record on disk: not in the branch's settlement, not
    // in what the join is told, not in the state
    const files = (await readdir(runDir(run.runId), { recursive: true })).filter((f) =>
      /\.(json|jsonl)$/.test(f),
    );
    for (const file of files) {
      const text = await readFile(join(runDir(run.runId), file), "utf8");
      expect(text, file).not.toContain(SECRET);
    }
    const settled = journal.find((r) => r.event === "branch_settled" && r.branch === "b");
    expect(String(settled?.reason)).toContain("[REDACTED");
    const reached = journal.find((r) => r.event === "join_reached");
    expect(JSON.stringify(reached?.feedbacks)).toContain("[REDACTED");
    expect(state.nodes.merge?.lastFailures?.[0]?.reason).toContain("[REDACTED");
    expect(state.forks?.f1?.arrived.b?.failure?.reason).toContain("[REDACTED");

    // the state and every journal record carry run-state format 2; meta keeps its own version
    expect(state.v).toBe(RECORD_VERSION);
    expect(journal.every((r) => r.v === RECORD_VERSION)).toBe(true);
    const meta = JSON.parse(await readFile(join(runDir(run.runId), "meta.json"), "utf8"));
    expect(meta.v).toBe(META_VERSION);
    expect(RECORD_VERSION).toBe(2);
  });

  test("t40_journal_and_state_carry_v2_other_records_keep_theirs", async () => {
    const h = host();
    const { run } = await h.start("split the work");
    await run.completeStep("plan", 1);
    await run.waitForRest(10_000);
    await run.completeStep("merge", 1);
    await run.waitForRest(10_000);
    expect((await run.state()).status).toBe("completed");
    const state = JSON.parse(await readFile(join(runDir(run.runId), "state.json"), "utf8"));
    expect(state.v).toBe(2);
    const journal = (await readFile(join(runDir(run.runId), "journal.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            v: number;
            event: string;
            engine?: { record_version: number; meta_version: number };
          },
      );
    expect(journal.every((r) => r.v === 2)).toBe(true);
    // the seal and the meta file are their own formats, unchanged by the break
    const seal = JSON.parse(await readFile(join(runDir(run.runId), "seal.json"), "utf8"));
    expect(seal.v).toBe(1);
    const meta = JSON.parse(await readFile(join(runDir(run.runId), "meta.json"), "utf8"));
    expect(meta.v).toBe(2);
    expect(META_VERSION).toBe(2);
    // and the engine record names the run-state format it writes
    const started = journal.find((r) => r.event === "run_started");
    if (started?.engine) {
      expect(started.engine.record_version).toBe(2);
      expect(started.engine.meta_version).toBe(2);
    }
  });
});

/**
 * A fork of an agent step and a command: the command ends when the file `go` appears in the working
 * directory, so a test says when that branch arrives.
 */
const WAITING_FORK = [
  "name: fork",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: a }",
  `  - { slug: b, kind: command, command: "node -e \\"const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync('go'))clearInterval(t)},50)\\"" }`,
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: merge }",
  "  - { from: b, to: merge }",
  "  - { from: b, to: merge, when: failed }",
  "",
].join("\n");

const CHANGED_MERGE = WAITING_FORK.replace("prompt: merge,", "prompt: merge the branches,");
const CHANGED_A = WAITING_FORK.replace("prompt: a }", "prompt: a carefully }");

describe("t40 repair in a fork on the host", () => {
  const waitingHost = () =>
    new LocalHost(parsePipeline(WAITING_FORK), { root: dir, heartbeatMs: 0 });
  /** Both branches open: `a` waits for the agent, `b` for the file. */
  async function openFork() {
    const h = waitingHost();
    const { run } = await h.start("split the work");
    await run.completeStep("plan", 1);
    expect((await run.state()).active.map((v) => [v.node, v.phase])).toEqual([
      ["a", "agent"],
      ["b", "engine"],
    ]);
    return { h, run };
  }
  const letBArrive = async (run: Awaited<ReturnType<typeof openFork>>["run"]) => {
    await writeFile(join(dir, "go"), "");
    await run.waitForRest(20_000);
    expect((await run.state()).forks?.f1?.arrived.b).toMatchObject({ node: "b", label: "passed" });
  };

  test("t40_pending_change_holds_hand_ins_only", async () => {
    const { h, run } = await openFork();
    const proposed = await run.proposeChange({ yaml: CHANGED_MERGE, summary: "say what to merge" });
    expect(proposed).toMatchObject({ ok: true, status: "proposed", change: { effects: [] } });
    const pending = await run.pendingChange();
    expect(pending?.info.blocking).toBe(true);

    // the worker's hand-in is held: nothing is judged while the person has not decided
    const held = await run.completeStep("a", 1);
    expect(held.ok && held.noop).toBe(true);
    expect((await run.state()).active.map((v) => v.node)).toEqual(["a", "b"]);
    // the command branch is not: it ends and arrives while the change waits
    await letBArrive(run);
    const state = await run.state();
    expect(state.active.map((v) => v.node)).toEqual(["a"]);
    expect((await h.store.readJournal(run.runId)).map((r) => r.event)).toContain("branch_settled");
    expect((await run.pendingChange())?.info.blocking).toBe(true);

    // accepted, the hand-in goes through and the join starts
    const fresh = await run.pendingChange();
    const accepted = await run.acceptChange({
      source: "proposal",
      text: CHANGED_MERGE,
      standing: fresh?.info.standing,
    });
    expect(accepted.ok).toBe(true);
    const done = await run.completeStep("a", 1);
    expect(done.ok && done.noop).not.toBe(true);
    await run.waitForRest(10_000);
    expect((await run.state()).active.map((v) => v.node)).toEqual(["merge"]);
  });

  test("t40_change_show_recomputes", async () => {
    const { run } = await openFork();
    const proposed = await run.proposeChange({ yaml: CHANGED_A, summary: "be careful" });
    expect(proposed.ok).toBe(true);
    const shown = await run.pendingChange();
    expect(shown?.info.effects).toEqual([{ kind: "restart", node: "a" }]);
    expect(shown?.info.redo.join("\n")).toContain('step "a" starts again');
    expect(shown?.info.standing).toContain("b#1");

    // what `pipeline changes show` prints is worked out again each time: the run moved on
    await letBArrive(run);
    const again = await run.pendingChange();
    expect(again?.hash).toBe(shown?.hash as string);
    expect(again?.info.effects).toEqual([{ kind: "restart", node: "a" }]);
    expect(again?.info.standing).not.toBe(shown?.info.standing as string);
    expect(again?.info.standing).not.toContain("b#1");

    // what is accepted is what was shown: the standing of the first look is refused
    const stale = await run.acceptChange({
      source: "proposal",
      text: CHANGED_A,
      standing: shown?.info.standing,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("PIPELINE_CHANGE_REFUSED");
      expect(stale.error.message).toContain("the run moved on since the change was shown");
    }
    expect((await run.state()).nodes.a?.attempt).toBe(1);
    const taken = await run.acceptChange({
      source: "proposal",
      text: CHANGED_A,
      standing: again?.info.standing,
    });
    expect(taken.ok).toBe(true);
    expect((await run.state()).nodes.a?.attempt).toBe(2);
    expect((await run.state()).active[0]?.fork).toEqual({ id: "f1", branch: "a" });
  });

  test("t40_history_reads_effects_list", async () => {
    const { run } = await openFork();
    await run.proposeChange({ yaml: CHANGED_A, summary: "be careful" });
    const shown = await run.pendingChange();
    const taken = await run.acceptChange({
      source: "proposal",
      text: CHANGED_A,
      standing: shown?.info.standing,
      reason: "the first try was sloppy",
    });
    expect(taken.ok).toBe(true);
    const { versions } = await run.history();
    expect(versions.map((v) => [v.how, v.effects])).toEqual([
      ["started", []],
      ["proposal", [{ kind: "restart", node: "a" }]],
    ]);
    expect(versions[1]).toMatchObject({ reason: "the first try was sloppy", current: true });
    const report = await run.report();
    expect(report.pipeline_changes[0]?.effects).toEqual([{ kind: "restart", node: "a" }]);
    await writeFile(join(dir, "go"), "");
    await run.waitForRest(20_000);
  });

  test("t40_restore_during_fork", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
    const file = join(dir, ".kodel", "pipelines", "fork.yaml");
    await writeFile(file, WAITING_FORK);
    await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
    git("add", "-A");
    git("commit", "-q", "-m", "pipeline");
    const pipelines = new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
    const started = await pipelines.start({
      pipeline: "fork",
      task: "split the work",
      restart: false,
    });
    const run = (await pipelines.open(started.run.runId)) as LocalRun;

    // before the fork opens, a third branch is accepted from the file
    const THIRD = WAITING_FORK.replace(
      "  - { slug: merge,",
      '  - { slug: c, kind: command, command: "node -e 0" }\n  - { slug: merge,',
    ).replace(
      "  - { from: b, to: merge, when: failed }\n",
      "  - { from: b, to: merge, when: failed }\n  - { from: plan, to: c }\n  - { from: c, to: merge }\n  - { from: c, to: merge, when: failed }\n",
    );
    await writeFile(file, THIRD);
    const pending = await run.pendingChange();
    expect(pending?.info.refused).toBeUndefined();
    const accepted = await run.acceptChange({
      source: "file",
      text: THIRD,
      standing: pending?.info.standing,
    });
    expect(accepted.ok).toBe(true);
    await run.completeStep("plan", 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const open = await run.state();
    expect(open.forks?.f1?.branches).toEqual(["a", "b", "c"]);
    expect(open.active.map((v) => v.node)).toContain("b");

    // the first version has two fork edges: it cannot come back while the fork is open, and the
    // file is left as it is
    const first = hashSource(WAITING_FORK);
    await expect(run.restoreFile(first)).rejects.toMatchObject({
      code: "PIPELINE_CHANGE_REFUSED",
      message: expect.stringContaining('the fork at "plan" is open'),
    });
    expect(await readFile(file, "utf8")).toBe(THIRD);
    // the version the run is on is written back as a matter of course
    expect(await run.restoreFile()).toMatchObject({ hash: hashSource(THIRD) });
    expect(await readFile(file, "utf8")).toBe(THIRD);

    await writeFile(join(dir, "go"), "");
    await run.waitForRest(20_000);
    await run.completeStep("a", 1);
    await run.waitForRest(10_000);
    expect((await run.state()).active.map((v) => v.node)).toEqual(["merge"]);
    // the join is being worked: its failed branches may still be run again, so the fork is open still
    await expect(run.restoreFile(first)).rejects.toMatchObject({ code: "PIPELINE_CHANGE_REFUSED" });
    expect(await readFile(file, "utf8")).toBe(THIRD);
    await run.completeStep("merge", 1);
    await run.waitForRest(10_000);
    expect((await run.state()).status).toBe("completed");
  });
});

// ── claims on the host (T-40, commit 3) ─────────────────────────────────────

/** Two agent branches and a join: what workers take. */
const AGENT_FORK = parsePipeline(
  [
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
    "",
  ].join("\n"),
);

describe("t40 claims on the host", () => {
  const config = (text: string) => writeFile(join(dir, ".kodel", "config.yaml"), text);
  async function openAgents(clock?: () => number, task = "split the work") {
    await mkdir(join(dir, ".kodel"), { recursive: true });
    const h = new LocalHost(AGENT_FORK, {
      root: dir,
      heartbeatMs: 0,
      ...(clock === undefined ? {} : { clock }),
    });
    // prompts are recorded (the default of a project), the rest of the history is off
    const history = defaultHistory();
    history.changes.enabled = false;
    history.executor.enabled = false;
    const { run } = await h.start(task, { history });
    await run.completeStep("plan", 1);
    expect((await run.state()).active.map((v) => v.node)).toEqual(["a", "b"]);
    return { h, run };
  }
  const files = async (id: string) =>
    (
      await Promise.all(
        (
          await readdir(runDir(id), { recursive: true })
        )
          .filter((f) => /\.(json|jsonl)$/.test(f))
          .map((f) => readFile(join(runDir(id), f), "utf8")),
      )
    ).join("\n");

  test("t40_token_generated_and_hashed_by_host", async () => {
    const { h, run } = await openAgents();
    const took = await run.takeStep({ node: "a" });
    if (took.status !== "claimed") throw new Error(`expected claimed, got ${took.status}`);
    expect(took.claim_token).toMatch(/^[0-9a-f]{32}$/);
    expect(took.step).toMatchObject({ slug: "a", attempt: 1, prompt: "do a" });
    const state = await run.state();
    expect(state.nodes.a?.claim).toMatchObject({
      token: hashSource(took.claim_token),
      by: `w-${hashSource(took.claim_token).slice(0, 8)}`,
    });
    // the token itself is written nowhere: not in the state, the journal or any other file of the run
    expect(await files(run.runId)).not.toContain(took.claim_token);
    const journal = await h.store.readJournal(run.runId);
    expect(journal.find((r) => r.event === "step_claimed")).toMatchObject({
      node: "a",
      attempt: 1,
    });
    // a completion with the token leaves no conflict, one without leaves one
    await run.completeStep("a", 1, undefined, undefined, undefined, took.claim_token);
    await run.takeStep({ node: "b" });
    await run.completeStep("b", 1);
    await run.waitForRest(10_000);
    const events = (await h.store.readJournal(run.runId)).filter(
      (r) => r.event === "step_claim_conflict",
    );
    expect(events.map((r) => r.node)).toEqual(["b"]);
  });

  test("t40_two_takes_race_under_lock", async () => {
    const { run } = await openAgents();
    const [one, two] = await Promise.all([
      run.takeStep({ node: "a" }),
      run.takeStep({ node: "a" }),
    ]);
    expect([one.status, two.status].sort()).toEqual(["claimed", "taken"]);
    const winner = one.status === "claimed" ? one : two;
    const loser = one.status === "taken" ? one : two;
    if (winner.status !== "claimed" || loser.status !== "taken") throw new Error("unreachable");
    expect(loser.taken_by).toBe(`w-${hashSource(winner.claim_token).slice(0, 8)}`);
    // without a slug two workers get the two different steps (another run: a start reuses a task's run)
    const fresh = await openAgents(undefined, "split another piece of work");
    const [x, y] = await Promise.all([fresh.run.takeStep({}), fresh.run.takeStep({})]);
    if (x.status !== "claimed" || y.status !== "claimed") throw new Error("both should be claimed");
    expect([x.step.slug, y.step.slug].sort()).toEqual(["a", "b"]);
  });

  test("t40_wait_s_waits_while_claimed_steps_open", async () => {
    const { h, run } = await openAgents();
    const a = await run.takeStep({ node: "a" });
    const b = await run.takeStep({ node: "b" });
    if (a.status !== "claimed" || b.status !== "claimed") throw new Error("not claimed");
    const service = new PipelineService(h as unknown as PipelineHost, { waitBudgetMs: 0 });
    // Everything is in the workers' hands: the wait goes on until they hand in, then answers at once.
    const begun = Date.now();
    const waiting = service.nextStep({ run_id: run.runId, wait_s: 20 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await service.nextStep({ run_id: run.runId })).toMatchObject({
      running: { open_steps: [{ node_slug: "a" }, { node_slug: "b" }] },
    });
    await run.completeStep("b", 1, undefined, undefined, undefined, b.claim_token);
    await run.completeStep("a", 1, undefined, undefined, undefined, a.claim_token);
    const answer = await waiting;
    expect(Date.now() - begun).toBeLessThan(10_000);
    expect(answer).toMatchObject({ ok: true, node: { slug: "merge" } });
  });

  test("t40_served_records_every_step", async () => {
    const { h, run } = await openAgents();
    await run.nextStep({ serve: {} });
    const served = (await h.store.readJournal(run.runId)).filter((r) => r.event === "step_served");
    expect(served.map((r) => [r.node, r.attempt])).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
    expect(Object.keys((await run.state()).served ?? {}).sort()).toEqual(["a:1", "b:1"]);
  });

  test("t40_served_hash_ignores_sibling_state", async () => {
    const { h, run } = await openAgents();
    await run.nextStep({ serve: {} });
    const first = (await h.store.readJournal(run.runId)).filter((r) => r.event === "step_served");
    // the sibling is taken, and the answer shows that; what is recorded for `a` is the same
    const took = await run.takeStep({ node: "b" });
    if (took.status !== "claimed") throw new Error("not claimed");
    const answer = await run.nextStep({ serve: {} });
    if (!("node" in answer)) throw new Error("expected a node");
    expect(answer.node.steps?.find((s) => s.slug === "b")?.taken_by).toBeDefined();
    const again = (await h.store.readJournal(run.runId)).filter((r) => r.event === "step_served");
    expect(again).toHaveLength(first.length);
    const recordA = again.find((r) => r.node === "a");
    expect(recordA?.prompt_hash).toBe(first.find((r) => r.node === "a")?.prompt_hash as string);
    // the file of a step holds the step alone: no siblings, no hold, no mode
    const file = (await h.store.readServed(run.runId, String(recordA?.ref))) as {
      answer: Record<string, unknown>;
    };
    expect(file.answer).toMatchObject({ slug: "a", attempt: 1, prompt: "do a" });
    for (const key of ["steps", "taken_by", "also_waiting", "note"]) {
      expect(file.answer, key).not.toHaveProperty(key);
    }
    expect((file.answer.execution as Record<string, unknown> | undefined)?.mode).toBeUndefined();
  });

  test("t40_served_not_recorded_for_completion_next", async () => {
    const { h, run } = await openAgents();
    await run.completeStep("a", 1);
    const next = await run.nextStep({ completionOf: "a", serve: {} });
    expect(next).toMatchObject({ running: { open_steps: [{ node_slug: "b", attempt: 1 }] } });
    const served = (await h.store.readJournal(run.runId)).filter((r) => r.event === "step_served");
    expect(served.filter((r) => r.node === "b")).toHaveLength(0);
    // the plain answer hands `b` out and records it
    await run.nextStep({ serve: {} });
    const after = (await h.store.readJournal(run.runId)).filter((r) => r.event === "step_served");
    expect(after.filter((r) => r.node === "b")).toHaveLength(1);
  });

  test("t40_agents_bad_value_never_fails_next_step", async () => {
    const { run } = await openAgents();
    await config("agents:\n  subagents: maybe\n");
    await expect(loadConfig(join(dir, ".kodel"))).rejects.toBeInstanceOf(KodelError);
    const answer = await run.nextStep({ serve: {}, subagents: { can: true } });
    if (!("node" in answer)) throw new Error("expected a node");
    // the defaults stand: `auto`, so the declaration decides, and the default cap and TTL
    expect(answer.node.execution?.mode).toBe("parallel");
    expect(answer.node.steps).toHaveLength(2);
    const took = await run.takeStep({ node: "a" });
    expect(took.status).toBe("claimed");
    const claim = (await run.state()).nodes.a?.claim;
    expect((claim?.until ?? 0) - (claim?.at ?? 0)).toBe(DEFAULT_AGENTS.claim_ttl_s * 1000);
  });

  test("t40_config_values_reach_next_step_in_host", async () => {
    let now = 1_000_000;
    const { run } = await openAgents(() => now);
    await config("agents:\n  subagents: yes\n  max_parallel: 1\n  claim_ttl_s: 60\n");
    const answer = await run.nextStep({ serve: {} });
    if (!("node" in answer)) throw new Error("expected a node");
    expect(answer.node.execution?.mode).toBe("parallel");
    expect(answer.node.steps?.map((s) => s.slug)).toEqual(["a"]);
    expect(answer.node.queued).toBe(1);
    const took = await run.takeStep({ node: "a" });
    expect(took.status).toBe("claimed");
    expect((await run.state()).nodes.a?.claim?.until).toBe(now + 60_000);
    // the claim lapses by the host's clock
    now += 60_001;
    const other = await run.takeStep({ node: "a" });
    expect(other.status).toBe("claimed");
    await config("agents:\n  subagents: no\n");
    const sequential = await run.nextStep({ serve: {}, subagents: { can: true } });
    if (!("node" in sequential)) throw new Error("expected a node");
    expect(sequential.node.execution?.mode).toBe("sequential");
  });
});
