/**
 * The cancel of a run through the host (NE3N), on a real store: a cancel racing another, a run whose
 * state or kept pipeline was changed outside kodel, a run held by a change of its pipeline, and a
 * worker that hands its step in after the run was canceled.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost, type LocalRun } from "../src";

const PIPELINE = (check: string) =>
  [
    "name: demo",
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    "    prompt: write it",
    "    checks:",
    `      - { kind: command, command: '${check}' }`,
    "  - slug: approve",
    "    kind: human",
    "    prompt: ok?",
    "edges:",
    "  - { from: write, to: approve }",
    "  - { from: approve, to: write, when: rejected }",
    "",
  ].join("\n");

const FILE = ".kodel/pipelines/demo.yaml";

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-cancel-")));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, FILE), PIPELINE("node -e 0"));
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
  await writeFile(join(dir, ".gitignore"), ".kodel/runs\n.kodel/worktrees\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
});

const started: LocalRun[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((run) => run.settle().catch(() => undefined)));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const host = () => new LocalPipelineHost({ root: dir, heartbeatMs: 0 });

async function startRun(): Promise<LocalRun> {
  const { run } = await host().start({ pipeline: "demo", task: "t", restart: false });
  const opened = (await host().open(run.runId)) as LocalRun;
  started.push(opened);
  return opened;
}

const runDir = (runId: string) => join(dir, ".kodel", "runs", runId);
const journalText = (runId: string) => readFile(join(runDir(runId), "journal.jsonl"), "utf8");
const ends = async (runId: string) =>
  (await journalText(runId))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { event: string })
    .filter((record) => record.event === "run_finished").length;

describe("tne3n a cancel through the host", () => {
  test("tne3n_two_concurrent_cancels_write_one_end", async () => {
    const run = await startRun();
    const a = (await host().open(run.runId)) as LocalRun;
    const b = (await host().open(run.runId)) as LocalRun;
    started.push(a, b);
    const [first, second] = await Promise.all([
      a.cancel({ reason: "one" }),
      b.cancel({ reason: "two" }),
    ]);
    expect(first.ok && second.ok).toBe(true);
    // exactly one of them wrote; the other found the run canceled
    expect([first, second].filter((d) => d.ok && d.noop === true)).toHaveLength(1);
    expect(await ends(run.runId)).toBe(1);
    expect((await run.state()).status).toBe("canceled");
  });

  test("tne3n_cancel_of_a_state_changed_outside_kodel_is_refused_and_writes_nothing", async () => {
    const run = await startRun();
    const statePath = join(runDir(run.runId), "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    state.nextVisitId = 99;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const stateBefore = await readFile(statePath, "utf8");
    const journalBefore = await journalText(run.runId);
    const decision = await run.cancel({ reason: "x" });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error.code).toBe("STATE_MODIFIED_EXTERNALLY");
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);
    expect(await journalText(run.runId)).toBe(journalBefore);
  });

  for (const how of ["removed", "changed"] as const) {
    test(`tne3n_cancel_of_a_run_whose_kept_pipeline_was_${how}_is_refused_and_writes_nothing`, async () => {
      const run = await startRun();
      const specs = join(runDir(run.runId), "specs");
      const [kept] = await readdir(specs);
      if (kept === undefined) throw new Error("the run kept no pipeline");
      if (how === "removed") await rm(join(specs, kept));
      else await writeFile(join(specs, kept), PIPELINE("node -e 7"));
      const stateBefore = await readFile(join(runDir(run.runId), "state.json"), "utf8");
      const journalBefore = await journalText(run.runId);
      // the run opened before the copy changed answers a refusal, not a throw
      const decision = await run.cancel({ reason: "x" });
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.error.code).toBe("STATE_MODIFIED_EXTERNALLY");
      // and a host opened after it refuses to open the run with that same reason
      await expect(host().open(run.runId)).rejects.toMatchObject({
        code: "STATE_MODIFIED_EXTERNALLY",
      });
      expect(await readFile(join(runDir(run.runId), "state.json"), "utf8")).toBe(stateBefore);
      expect(await journalText(run.runId)).toBe(journalBefore);
    });
  }

  test("tne3n_cancel_ends_a_run_held_by_a_change_of_its_pipeline", async () => {
    const run = await startRun();
    await writeFile(join(dir, FILE), PIPELINE("node -e 1"));
    const done = await run.completeStep("write", 1);
    expect(done.ok && done.noop).toBe(true);
    const held = await run.nextStep({ atCompletion: true });
    expect((held as { waiting?: { reason?: string } }).waiting?.reason).toBe("pipeline_changed");
    const decision = await run.cancel({ reason: "neither version is wanted" });
    expect(decision.ok).toBe(true);
    const state = await run.state();
    expect(state.status).toBe("canceled");
    expect(state.active).toEqual([]);
    expect(state.pauses).toEqual([]);
    expect(await ends(run.runId)).toBe(1);
    expect(await run.nextStep()).toMatchObject({ done: true, run_status: "canceled" });
  });

  test("tne3n_late_complete_after_cancel_refused", async () => {
    const run = await startRun();
    const took = await run.takeStep({ node: "write" });
    expect(took.status).toBe("claimed");
    const token = took.status === "claimed" ? took.claim_token : "";
    expect((await run.cancel({ reason: "stop" })).ok).toBe(true);
    expect(Object.values((await run.state()).nodes).some((n) => n.claim !== undefined)).toBe(false);
    const journalBefore = await journalText(run.runId);
    const stateBefore = await readFile(join(runDir(run.runId), "state.json"), "utf8");
    const late = await run.completeStep("write", 1, "done", undefined, undefined, token);
    expect(late.ok === false || late.noop === true).toBe(true);
    expect(await journalText(run.runId)).toBe(journalBefore);
    expect(await readFile(join(runDir(run.runId), "state.json"), "utf8")).toBe(stateBefore);
    expect((await run.state()).status).toBe("canceled");
  });
});
