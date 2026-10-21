import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
          effect: { kind: "none" },
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
});
