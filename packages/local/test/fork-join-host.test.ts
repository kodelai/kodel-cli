/**
 * Forks on the real host (T-40): what reaches the disk goes through redaction, and the records a run
 * writes carry run-state format 2 while the other records keep their own versions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePipeline, RECORD_VERSION } from "@kodel-ai/pipeline-core";
import { hashSource, LocalHost, LocalPipelineHost, type LocalRun, META_VERSION } from "../src";

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
