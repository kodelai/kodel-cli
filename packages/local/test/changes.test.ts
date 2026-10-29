import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChoiceNeeded, PipelineService } from "@kodel-ai/pipeline-core";
import { hashSource, LocalPipelineHost, type LocalRun } from "../src";

// The test ids are a placeholder until the decision log gives this change one (see the plan).

const PIPELINE = (check: string, prompt = "write it") =>
  [
    "name: demo",
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    `    prompt: ${prompt}`,
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

const V1 = PIPELINE("node -e 0");
const FILE = ".kodel/pipelines/demo.yaml";

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
const git_ = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

async function makeRepo(config: string): Promise<void> {
  dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-changes-")));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, FILE), V1);
  await writeFile(join(dir, ".kodel", "config.yaml"), config);
  await writeFile(join(dir, ".gitignore"), ".kodel/runs\n.kodel/worktrees\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
}

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const host = () => new LocalPipelineHost({ root: dir, heartbeatMs: 0 });

async function startRun(h = host()): Promise<LocalRun> {
  const { run } = await h.start({ pipeline: "demo", task: "t", restart: false });
  return (await h.open(run.runId)) as LocalRun;
}

/** The file the run's own pipeline is kept in: in its worktree, when it has one. */
async function ownFile(run: LocalRun): Promise<string> {
  const { workdir } = await run.state();
  return join(workdir ?? dir, FILE);
}

const waitingReason = (step: unknown) =>
  (step as { waiting?: { reason?: string } }).waiting?.reason;

describe("a pipeline file edited under a run in the repository root", () => {
  beforeEach(async () => {
    await makeRepo("worktree:\n  mode: off\n");
  });

  test("a_changed_file_is_told_to_the_agent_and_holds_the_step_at_completion", async () => {
    const run = await startRun();
    await writeFile(join(dir, FILE), PIPELINE("node -e 1"));

    const step = await run.nextStep();
    expect(step).toMatchObject({
      node: {
        slug: "write",
        pipeline_change: {
          source: "file",
          watched: FILE,
          changes: [{ slug: "write", changes: ["checks"] }],
          effects: [],
          apply: `kodel pipeline changes apply ${run.runId}`,
        },
      },
    });

    const done = await run.completeStep("write", 1);
    expect(done.ok && done.noop).toBe(true);
    expect((await run.state()).nodes.write?.status).toBe("running");
    const held = await run.nextStep({ atCompletion: true });
    expect(waitingReason(held)).toBe("pipeline_changed");
    expect(JSON.stringify(held)).not.toContain("node -e 1"); // the new text is not sent to the agent
  });

  test("tNN_the_config_turns_the_offer_of_kodel_wait_off_and_on_again_without_a_restart", async () => {
    const run = await startRun();
    await run.completeStep("write", 1);
    await run.waitForRest(5_000);
    // What a command that only looks says and what the agent is told must agree.
    const offered = async () => {
      const [looked, told] = [await run.inspect(), await run.nextStep()].map((step) =>
        JSON.stringify(step).includes(`kodel wait ${run.runId}`),
      );
      expect(looked).toBe(told);
      return looked;
    };
    expect(await offered()).toBe(true);
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      "worktree:\n  mode: off\nagent_hints:\n  wait: false\n",
    );
    expect(await offered()).toBe(false);
    // A config that cannot be read leaves the default (the commands that need it say what is wrong).
    await writeFile(join(dir, ".kodel", "config.yaml"), "agent_hints: [\n");
    expect(await offered()).toBe(true);
    await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
    expect(await offered()).toBe(true);
  });

  test("tNN_kodel_wait_is_not_offered_behind_a_step", async () => {
    // Behind a step the run still reads as the agent's step to a command that only looks, so such a
    // command would return at once and the agent would go round again.
    const run = await startRun();
    await writeFile(join(dir, FILE), PIPELINE("node -e 1"));
    const held = await run.nextStep({ atCompletion: true });
    expect(waitingReason(held)).toBe("pipeline_changed");
    expect(JSON.stringify(held)).not.toContain("kodel wait");
  });

  test("tNN_kodel_wait_is_offered_when_the_change_waits_behind_a_gate", async () => {
    const run = await startRun();
    await run.completeStep("write", 1);
    await run.waitForRest(5_000);
    await writeFile(join(dir, FILE), PIPELINE("node -e 1"));
    const step = await run.nextStep();
    expect(waitingReason(step)).toBe("pipeline_changed");
    expect(JSON.stringify(step)).toContain(`kodel wait ${run.runId}`);
  });

  test("restoring_the_file_ends_the_pending_change_without_a_command", async () => {
    const run = await startRun();
    await writeFile(join(dir, FILE), PIPELINE("node -e 1"));
    expect(waitingReason(await run.nextStep({ atCompletion: true }))).toBe("pipeline_changed");

    await writeFile(join(dir, FILE), V1);
    const step = await run.nextStep({ atCompletion: true });
    expect(step).toMatchObject({ node: { slug: "write" } });
    expect(JSON.stringify(step)).not.toContain("pipeline_change");
    const done = await run.completeStep("write", 1);
    expect(done.ok && done.noop).not.toBe(true);
  });

  test("a_comment_or_whitespace_edit_is_not_a_change", async () => {
    const run = await startRun();
    await writeFile(join(dir, FILE), `# a note\n${V1.replace("name: demo", "name:   demo")}\n\n`);
    expect(await run.pendingChange()).toBeUndefined();
    expect(JSON.stringify(await run.nextStep())).not.toContain("pipeline_change");
  });

  test("an_unparsable_watched_file_is_not_a_pending_change", async () => {
    const run = await startRun();
    await writeFile(join(dir, FILE), "name: demo\nnodes: [\n");
    expect(await run.pendingChange()).toBeUndefined();
    const done = await run.completeStep("write", 1);
    expect(done.ok && done.noop).not.toBe(true);
  });

  test("a_change_that_cannot_be_accepted_is_told_but_holds_nothing_back", async () => {
    const run = await startRun();
    // `write` is where the run stands, so the first node may not change its name
    await writeFile(join(dir, FILE), V1.replace("name: demo", "name: other"));
    const found = await run.pendingChange();
    expect(found?.info.refused).toContain("name of the pipeline");
    expect(found?.info.blocking).toBe(false);
    const done = await run.completeStep("write", 1);
    expect(done.ok && done.noop).not.toBe(true);
  });

  test("accepting_a_change_moves_the_run_to_the_new_version", async () => {
    const run = await startRun();
    const text = PIPELINE('node -e "process.exit(3)"');
    await writeFile(join(dir, FILE), text);
    const found = await run.pendingChange();
    expect(found).toBeDefined();

    const decision = await run.acceptChange({ source: "file", text: found?.text ?? "" });
    expect(decision.ok).toBe(true);

    const state = await run.state();
    expect(state.specHash).toBe(hashSource(text));
    const kept = join(dir, ".kodel", "runs", run.runId, "specs", `${state.specHash}.yaml`);
    expect(await readFile(kept, "utf8")).toBe(text);
    const journal = (
      await readFile(join(dir, ".kodel", "runs", run.runId, "journal.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string });
    expect(journal.map((r) => r.event)).toContain("pipeline_accepted");
    expect(await run.pendingChange()).toBeUndefined();

    // the step is judged by the new check: it fails, where the old one would have passed
    await run.completeStep("write", 1);
    await run.waitForRest(10_000);
    expect((await run.state()).nodes.write?.lastFailure?.source).toBe("check:command");
  });

  test("hp9r_check_ids_survive_a_restart_and_a_recheck_after_an_accept", async () => {
    const first = host();
    const run = await startRun(first);
    const failing = PIPELINE('node -e "process.exit(3)"');
    await writeFile(join(dir, FILE), failing);
    const found = await run.pendingChange();
    await run.acceptChange({ source: "file", text: found?.text ?? "" });
    await run.completeStep("write", 1);
    await run.waitForRest(10_000);
    expect((await run.state()).nodes.write?.lastFailure).toMatchObject({
      source: "check:command",
      check_id: "write/command#1",
    });

    // a new process opens the run: the failure still names the check
    const reopened = (await host().open(run.runId)) as LocalRun;
    expect((await reopened.state()).nodes.write?.lastFailure?.check_id).toBe("write/command#1");

    // the person accepts a fixed condition; the node is checked again under the new version
    await writeFile(join(dir, FILE), V1);
    const fixed = await reopened.pendingChange();
    await reopened.acceptChange({ source: "file", text: fixed?.text ?? "" });
    await reopened.completeStep("write", 2);
    await reopened.waitForRest(10_000);

    const rows = (await readFile(join(dir, ".kodel", "runs", run.runId, "journal.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((r) => r.event === "check_finished");
    expect(rows.map((r) => [r.attempt, r.passed, r.check_id])).toEqual([
      [1, false, "write/command#1"],
      [2, true, "write/command#1"],
    ]);
    expect(rows[0]?.params_hash).not.toBe(rows[1]?.params_hash);
  });

  test("a_run_opened_by_another_process_follows_an_accept_made_by_the_first", async () => {
    const first = host();
    const run = await startRun(first);
    const text = PIPELINE("node -e 0", "write it twice");
    await writeFile(join(dir, FILE), text);
    // the person's command runs in its own process, with its own host
    const other = (await host().open(run.runId)) as LocalRun;
    await other.acceptChange({ source: "file", text });

    const again = (await first.open(run.runId)) as LocalRun;
    expect(JSON.stringify(await again.nextStep())).toContain("write it twice");
  });

  test("the_pipeline_file_comes_from_the_state_not_from_meta", async () => {
    const run = await startRun();
    const path = join(dir, ".kodel", "runs", run.runId, "meta.json");
    const meta = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(join(dir, "elsewhere.yaml"), PIPELINE("node -e 1"));
    meta.pipelineFile = "elsewhere.yaml";
    await writeFile(path, JSON.stringify(meta));
    expect(await run.pendingChange()).toBeUndefined();
  });

  test("a_watched_file_that_is_a_link_out_of_the_repository_is_not_read", async () => {
    const run = await startRun();
    const outside = await mkdtemp(join(tmpdir(), "kodel-outside-"));
    try {
      await writeFile(join(outside, "demo.yaml"), PIPELINE("node -e 1"));
      await rm(join(dir, FILE));
      await symlink(join(outside, "demo.yaml"), join(dir, FILE));
      expect(await run.pendingChange()).toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a_change_at_a_waiting_gate_is_answered_as_waiting_for_the_change_first", async () => {
    const run = await startRun();
    await run.completeStep("write", 1);
    await run.waitForRest(10_000);
    expect(waitingReason(await run.nextStep())).toBe("gate");

    await writeFile(join(dir, FILE), PIPELINE("node -e 1"));
    const step = await run.nextStep();
    expect(step).toMatchObject({
      waiting: {
        reason: "pipeline_changed",
        behind: "gate",
        how_to_decide: { cli: expect.any(String) },
      },
    });
  });
});

describe("a pipeline file edited under a run in its own worktree", () => {
  beforeEach(async () => {
    await makeRepo("worktree:\n  mode: auto\n");
  });

  test("only_the_copy_in_the_worktree_counts_not_the_root", async () => {
    const run = await startRun();
    const own = await ownFile(run);
    expect(own).not.toBe(join(dir, FILE));

    await writeFile(join(dir, FILE), PIPELINE("node -e 1")); // the root: other runs and the next ones
    expect(await run.pendingChange()).toBeUndefined();

    await writeFile(own, PIPELINE("node -e 2")); // the run's own copy
    const found = await run.pendingChange();
    expect(found?.info.changes).toEqual([{ slug: "write", changes: ["checks"] }]);
    expect(dirname(own)).toContain(".kodel/worktrees");
  });

  test("accepting_a_proposal_writes_the_worktree_copy_not_the_root", async () => {
    const run = await startRun();
    const own = await ownFile(run);
    const text = PIPELINE("node -e 2");
    expect((await run.proposeChange({ yaml: text, summary: "s" })).ok).toBe(true);
    const found = await run.pendingChange();
    expect(found?.info.source).toBe("proposal");

    expect((await run.acceptChange({ source: "proposal", text })).ok).toBe(true);
    expect(await readFile(own, "utf8")).toBe(text);
    expect(await readFile(join(dir, FILE), "utf8")).toBe(V1);
    expect(await run.pendingChange()).toBeUndefined();
  });
});

describe("the agent's proposal to change the pipeline", () => {
  beforeEach(async () => {
    await makeRepo("worktree:\n  mode: off\n");
  });

  const proposal = (check = "node -e 2") => PIPELINE(check);

  test("propose_change_writes_no_pipeline_file", async () => {
    const run = await startRun();
    const outcome = await run.proposeChange({ yaml: proposal(), summary: "a different check" });
    expect(outcome).toMatchObject({
      ok: true,
      status: "proposed",
      change: {
        source: "proposal",
        changes: [{ slug: "write", changes: ["checks"] }],
        apply: `kodel pipeline changes apply ${run.runId}`,
      },
    });
    expect(await readFile(join(dir, FILE), "utf8")).toBe(V1);
    const proposed = join(dir, ".kodel", "runs", run.runId, "pending", "proposal.yaml");
    expect(await readFile(proposed, "utf8")).toBe(proposal());
  });

  test("a_proposal_holds_the_step_like_a_change_in_the_file_does", async () => {
    const run = await startRun();
    await run.proposeChange({ yaml: proposal(), summary: "s" });
    const done = await run.completeStep("write", 1);
    expect(done.ok && done.noop).toBe(true);
    const held = await run.nextStep({ atCompletion: true });
    expect(held).toMatchObject({
      waiting: { reason: "pipeline_changed", pipeline_change: { source: "proposal" } },
    });
  });

  test("propose_change_refuses_an_invalid_or_refused_pipeline", async () => {
    const run = await startRun();
    expect(await run.proposeChange({ yaml: "name: x\nnodes: [", summary: "s" })).toMatchObject({
      ok: false,
      code: "PIPELINE_INVALID",
    });
    expect(
      await run.proposeChange({ yaml: V1.replace("name: demo", "name: other"), summary: "s" }),
    ).toMatchObject({ ok: false, code: "PIPELINE_CHANGE_REFUSED" });
    expect(await run.proposeChange({ yaml: V1, summary: "s" })).toMatchObject({
      ok: false,
      code: "PIPELINE_CHANGE_REFUSED",
    });
    expect(await run.pendingChange()).toBeUndefined();
  });

  test("propose_change_refuses_a_pipeline_with_a_secret_in_it", async () => {
    const run = await startRun();
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const outcome = await run.proposeChange({ yaml: proposal(`echo ${key}`), summary: "s" });
    expect(outcome).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(await run.pendingChange()).toBeUndefined();
  });

  test("a_new_proposal_replaces_the_old_and_an_empty_one_takes_it_back", async () => {
    const run = await startRun();
    await run.proposeChange({ yaml: proposal("node -e 2"), summary: "first" });
    await run.proposeChange({ yaml: proposal("node -e 3"), summary: "second" });
    expect((await run.pendingChange())?.text).toBe(proposal("node -e 3"));

    expect(await run.proposeChange({ yaml: "", summary: "never mind" })).toMatchObject({
      ok: true,
      status: "withdrawn",
    });
    expect(await run.pendingChange()).toBeUndefined();
    expect(await run.proposeChange({ yaml: "", summary: "again" })).toMatchObject({
      status: "none",
    });
    const journal = (
      await readFile(join(dir, ".kodel", "runs", run.runId, "journal.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; summary?: string; withdrawn?: boolean });
    const proposals = journal.filter((r) => r.event === "pipeline_change_proposed");
    expect(proposals.map((r) => r.summary)).toEqual(["first", "second", "never mind"]);
    expect(proposals.at(-1)?.withdrawn).toBe(true);
  });

  test("a_proposal_equal_to_the_version_the_run_is_on_is_not_pending", async () => {
    const run = await startRun();
    await run.proposeChange({ yaml: proposal(), summary: "s" });
    await run.acceptChange({ source: "proposal", text: proposal() });
    // the same text proposed again, or left behind: nothing to decide
    await mkdir(join(dir, ".kodel", "runs", run.runId, "pending"), { recursive: true });
    await writeFile(join(dir, ".kodel", "runs", run.runId, "pending", "proposal.yaml"), proposal());
    expect(await run.pendingChange()).toBeUndefined();
  });

  test("a_proposal_is_taken_when_the_run_is_paused_and_refused_when_it_is_over", async () => {
    const run = await startRun();
    await run.cancel();
    expect(await run.proposeChange({ yaml: proposal(), summary: "s" })).toMatchObject({
      ok: false,
      code: "NODE_NOT_RUNNING",
    });
  });

  test("resolve_with_a_run_gives_the_pinned_text", async () => {
    const run = await startRun();
    await writeFile(join(dir, FILE), PIPELINE("node -e 9")); // the file moved on; the run did not
    const pinned = await run.pinnedPipeline();
    expect(pinned.yaml).toBe(V1);
    expect(pinned.hash).toBe(hashSource(V1));
  });

  test("a_note_says_which_version_and_step_it_was_about", async () => {
    const run = await startRun();
    await run.feedback({ category: "wrong_check", message: "the limit counts tests" });
    const journal = (
      await readFile(join(dir, ".kodel", "runs", run.runId, "journal.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; spec?: string; node?: string });
    expect(journal.find((r) => r.event === "feedback_reported")).toMatchObject({
      spec: hashSource(V1),
      node: "write",
    });
  });

  test("restart_note_reaches_the_agent", async () => {
    const run = await startRun();
    const text = PIPELINE("node -e 0", "write it better");
    await run.proposeChange({ yaml: text, summary: "s" });
    await run.acceptChange({ source: "proposal", text });
    const step = await run.nextStep();
    expect(step).toMatchObject({
      node: {
        slug: "write",
        attempt: 2,
        reentry_feedback: expect.stringContaining("The pipeline was changed under this run"),
      },
    });
  });
});

describe("starting a run while the pipeline file has changes that are not committed", () => {
  const DIRTY = PIPELINE("node -e 2");
  const start = (h: LocalPipelineHost, version?: "working" | "committed", task = "t") =>
    h.start({
      pipeline: "demo",
      task,
      restart: false,
      ...(version === undefined ? {} : { pipeline_version: version }),
    });

  beforeEach(async () => {
    await makeRepo("worktree:\n  mode: auto\n");
    await writeFile(join(dir, FILE), DIRTY); // the root has the edit, the last commit does not
  });

  test("start_with_uncommitted_pipeline_asks_and_creates_nothing", async () => {
    const h = host();
    const error = await start(h).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChoiceNeeded);
    expect((error as ChoiceNeeded).choice).toMatchObject({
      reason: "pipeline_uncommitted",
      pipeline: "demo",
      file: FILE,
      options: ["working", "committed"],
      changes: [{ slug: "write", changes: ["checks"] }],
    });
    expect((error as ChoiceNeeded).choice.tell_the_person).toContain("Do not choose yourself");
    expect(await h.runSummaries()).toEqual([]);
    expect(git_("worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  test("the_service_answers_with_the_choice_and_no_run_id", async () => {
    const svc = new PipelineService(host());
    const answer = await svc.start({ task: "t", pipeline: "demo" });
    expect(answer).toMatchObject({
      ok: true,
      started: false,
      choice: { options: expect.any(Array) },
    });
    expect(JSON.stringify(answer)).not.toContain("run_id");
  });

  test("start_working_copies_the_root_file_into_the_worktree", async () => {
    const { run } = await start(host(), "working");
    const state = await run.state();
    expect(state.specHash).toBe(hashSource(DIRTY));
    expect(await readFile(join(state.workdir ?? "", FILE), "utf8")).toBe(DIRTY);
    expect(await (run as LocalRun).pendingChange()).toBeUndefined();
  });

  test("start_committed_pins_head", async () => {
    const { run } = await start(host(), "committed");
    const state = await run.state();
    expect(state.specHash).toBe(hashSource(V1));
    expect(await readFile(join(state.workdir ?? "", FILE), "utf8")).toBe(V1);
    expect(await readFile(join(dir, FILE), "utf8")).toBe(DIRTY); // the root is left alone
    expect(await (run as LocalRun).pendingChange()).toBeUndefined();
  });

  test("start_new_untracked_pipeline_gets_a_copy_without_a_question", async () => {
    git("rm", "-q", "--cached", FILE);
    git("commit", "-q", "-m", "stop tracking");
    const { run } = await start(host());
    const state = await run.state();
    expect(state.specHash).toBe(hashSource(DIRTY));
    expect(await readFile(join(state.workdir ?? "", FILE), "utf8")).toBe(DIRTY);
  });

  test("start_config_default_skips_the_question", async () => {
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      "worktree:\n  mode: auto\npipeline:\n  uncommitted: committed\n",
    );
    const { run } = await start(host());
    expect((await run.state()).specHash).toBe(hashSource(V1));
  });

  test("a_comment_or_whitespace_difference_is_not_a_question", async () => {
    await writeFile(join(dir, FILE), `# a note\n${V1}\n\n`);
    const { run } = await start(host());
    expect((await run.state()).specHash).toBe(hashSource(`# a note\n${V1}\n\n`));
    expect(await (run as LocalRun).pendingChange()).toBeUndefined();
  });

  test("a_run_that_exists_is_picked_up_without_a_question", async () => {
    const h = host();
    const first = await start(h, "committed");
    const again = await start(h);
    expect(again.status).toBe("reused");
    expect(again.run.runId).toBe(first.run.runId);
  });
});
