import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRegistry,
  type PipelineSpec,
  parsePipeline,
  type RunState,
} from "@kodel-ai/pipeline-core";
import { GitSnapshotter, LocalHost, type LocalRun } from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-host-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const initGit = () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
};

const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

const COMMANDS = parsePipeline(
  [
    "name: cmds",
    "nodes:",
    "  - slug: first",
    "    kind: command",
    `    command: node -e "console.log('one')"`,
    "  - slug: second",
    "    kind: command",
    `    command: node -e "console.log('two')"`,
    "edges:",
    "  - { from: first, to: second }",
    "  - { from: first, to: second, when: failed }",
    "  - { from: second, to: first, when: failed }",
    "",
  ].join("\n"),
);

const host = (spec: PipelineSpec, over: Record<string, unknown> = {}) =>
  new LocalHost(spec, { root: dir, heartbeatMs: 0, ...over });

async function finish(run: LocalRun): Promise<RunState> {
  await run.settle();
  return run.state();
}

describe("running real commands", () => {
  test("a pipeline of commands runs to completion without an agent", async () => {
    const h = host(COMMANDS);
    const { run, reused } = await h.start("do the thing");
    expect(reused).toBe(false);
    const state = await finish(run);
    expect(state.status).toBe("completed");
    expect(state.trail).toEqual(["first", "second"]);
    const events = (await h.store.readJournal(run.runId)).map((r) => r.event);
    expect(events).toEqual([
      "run_started",
      "node_entered",
      "command_finished",
      "node_finished",
      "node_entered",
      "command_finished",
      "node_finished",
      "run_finished",
    ]);
  });

  test("a failing command routes by its label and the agent can see why", async () => {
    const spec = parsePipeline(
      [
        "name: failing",
        "nodes:",
        "  - slug: a",
        "    kind: command",
        `    command: node -e "console.log('boom happened'); process.exit(2)"`,
        "  - slug: b",
        "    kind: command",
        `    command: node -e "0"`,
        "edges:",
        "  - { from: a, to: b }",
        "  - { from: a, to: b, when: failed }",
        "  - { from: b, to: a, when: failed }",
        "",
      ].join("\n"),
    );
    const h = host(spec);
    const { run } = await h.start("t");
    const state = await finish(run);
    expect(state.nodes.a).toMatchObject({ status: "failed", outcome: "failed" });
    expect(state.nodes.a?.lastFailure?.reason).toContain("exited with 2, expected 0");
    expect(state.nodes.a?.lastFailure?.reason).toContain("boom happened");
    expect(state.status).toBe("completed");
  });

  test("an expected non-zero exit code counts as success", async () => {
    const spec = parsePipeline(
      [
        "name: expecting",
        "nodes:",
        "  - slug: a",
        "    kind: command",
        `    command: node -e "process.exit(3)"`,
        "    expect: { exit: 3 }",
        "  - slug: b",
        "    kind: command",
        `    command: node -e "0"`,
        "edges:",
        "  - { from: a, to: b }",
        "  - { from: a, to: b, when: failed }",
        "  - { from: b, to: a, when: failed }",
        "",
      ].join("\n"),
    );
    const { run } = await host(spec).start("t");
    const state = await finish(run);
    expect(state.nodes.a).toMatchObject({ status: "passed", outcome: "passed", attempt: 1 });
    expect(state.status).toBe("completed");
  });

  test("a command that runs past its timeout fails and says so", async () => {
    const spec = parsePipeline(
      [
        "name: slow",
        "nodes:",
        "  - slug: a",
        "    kind: command",
        "    timeout: 1",
        `    command: node -e "setTimeout(() => {}, 60000)"`,
        "  - slug: b",
        "    kind: command",
        `    command: node -e "0"`,
        "edges:",
        "  - { from: a, to: b }",
        "  - { from: a, to: b, when: failed }",
        "  - { from: b, to: a, when: failed }",
        "",
      ].join("\n"),
    );
    const { run } = await host(spec).start("t");
    const state = await finish(run);
    expect(state.nodes.a?.lastFailure?.reason).toContain("timed out after 1 s");
  }, 20_000);

  test("a secret printed by a command never reaches the state or the journal", async () => {
    const spec = parsePipeline(
      [
        "name: leaky",
        "nodes:",
        "  - slug: a",
        "    kind: command",
        `    command: node -e "console.log('key is ${secret}'); process.exit(1)"`,
        "  - slug: b",
        "    kind: command",
        `    command: node -e "0"`,
        "edges:",
        "  - { from: a, to: b }",
        "  - { from: a, to: b, when: failed }",
        "  - { from: b, to: a, when: failed }",
        "",
      ].join("\n"),
    );
    const h = host(spec);
    const { run } = await h.start("t");
    await finish(run);
    for (const file of ["state.json", "journal.jsonl"]) {
      const text = await readFile(join(h.store.runDir(run.runId), file), "utf8");
      expect(text).not.toContain(secret);
    }
    expect((await run.state()).nodes.a?.lastFailure?.reason).toContain("[REDACTED:aws-key]");
  });
});

describe("starting and finding runs", () => {
  test("starting the same task again returns the run that is still active", async () => {
    const spec = parsePipeline(
      [
        "name: waits",
        "nodes:",
        "  - slug: ask",
        "    kind: human",
        "    prompt: ok?",
        "  - slug: redo",
        "    kind: agent",
        "    prompt: do it again",
        "edges:",
        "  - { from: ask, to: redo, when: rejected }",
        "",
      ].join("\n"),
    );
    const h = host(spec);
    const first = await h.start("same task");
    const second = await h.start("same task");
    expect(second.reused).toBe(true);
    expect(second.run.runId).toBe(first.run.runId);
    await first.run.decideHuman("ask", "approved");
    const third = await h.start("same task");
    expect(third).toMatchObject({ reused: false, terminal: true });
    expect(third.run.runId).toBe(first.run.runId);
    const again = await h.start("same task", { restart: true });
    expect(again).toMatchObject({ reused: false, terminal: false });
    expect(again.run.runId).not.toBe(first.run.runId);
  });

  test("the pipeline source a run started with is kept next to it", async () => {
    const { run } = await host(COMMANDS, { source: "name: cmds # as written\n" }).start("t");
    const { specHash } = await run.state();
    const kept = await readFile(
      join(dir, ".kodel", "runs", run.runId, "specs", `${specHash}.yaml`),
      "utf8",
    );
    expect(kept).toBe("name: cmds # as written\n");
  });

  test("the same task with other spacing is the same task", async () => {
    const h = host(COMMANDS);
    const first = await h.start("add  a limit");
    const second = await h.start(" add a limit ");
    expect(second.run.runId).toBe(first.run.runId);
    expect((await first.run.state()).task).toBe("add a limit");
  });

  test("two starts at once make one run", async () => {
    const h = host(COMMANDS);
    const [a, b] = await Promise.all([h.start("t"), h.start("t")]);
    expect(b.run.runId).toBe(a.run.runId);
    expect((await h.store.listRuns()).length).toBe(1);
  });

  test("a run that could not be started leaves nothing behind", async () => {
    class BrokenGit extends GitSnapshotter {
      override async isRepo() {
        return true;
      }
      override async snapshot(): Promise<string> {
        throw new Error("git is broken");
      }
    }
    const snapshotter = new BrokenGit(dir);
    const spec = parsePipeline(
      [
        "name: snap",
        "nodes:",
        "  - slug: a",
        "    kind: agent",
        "    prompt: x",
        "    checks:",
        '      - { kind: diff, paths: ["x"] }',
        "",
      ].join("\n"),
    );
    const h = new LocalHost(spec, { root: dir, heartbeatMs: 0, snapshotter });
    await expect(h.start("t")).rejects.toThrow("git is broken");
    expect((await h.store.listRuns()).length).toBe(0);
  });

  test("waitForRest returns when the work is done, or when the time is up", async () => {
    const { run } = await host(COMMANDS).start("t");
    await run.waitForRest(10_000);
    expect((await run.state()).status).toBe("completed");
    await run.waitForRest(0);
  });

  test("a different task gets its own run", async () => {
    const h = host(COMMANDS);
    const a = await h.start("one");
    const b = await h.start("two");
    expect(a.run.runId).not.toBe(b.run.runId);
  });

  test("a pipeline with a diff check needs a git repository, and says so before anything is created", async () => {
    const spec = parsePipeline(
      [
        "name: needs-git",
        "nodes:",
        "  - slug: work",
        "    kind: agent",
        "    prompt: do it",
        "    checks:",
        '      - { kind: diff, paths: ["a/**"] }',
        "",
      ].join("\n"),
    );
    const h = host(spec);
    await expect(h.start("t")).rejects.toThrow("needs a git repository");
    expect(await h.store.listRuns()).toEqual([]);
  });

  test("the same pipeline works in a git repository", async () => {
    initGit();
    const spec = parsePipeline(
      [
        "name: with-git",
        "nodes:",
        "  - slug: work",
        "    kind: agent",
        "    prompt: do it",
        "    checks:",
        '      - { kind: diff, paths: ["a/**"] }',
        "",
      ].join("\n"),
    );
    const { run } = await host(spec).start("t");
    expect((await run.state()).nodes.work?.status).toBe("running");
    const kept = Object.keys(await host(spec).store.readSnapshots(run.runId)).sort();
    expect(kept).toEqual(["run", "visit:1"]);
  });

  test("a secret in the task is redacted before anything is saved", async () => {
    const h = host(COMMANDS);
    const { run } = await h.start(`deploy with ${secret}`);
    await finish(run);
    expect((await run.state()).task).not.toContain(secret);
    expect((await h.store.readMeta(run.runId))?.task).not.toContain(secret);
  });

  test("the state on disk is all a new process needs", async () => {
    const { run } = await host(COMMANDS).start("t");
    await finish(run);
    const other = host(COMMANDS).open(run.runId);
    expect((await other.state()).status).toBe("completed");
    expect(await other.nextStep()).toEqual({ done: true, run_status: "completed" });
  });
});

describe("result reports", () => {
  const REVIEW = parsePipeline(
    [
      "name: reviewing",
      "nodes:",
      "  - slug: review",
      "    kind: agent",
      "    prompt: review it",
      "    checks:",
      "      - kind: result",
      "        columns: { severity: { enum: [major, minor] }, note: text }",
      "        fail_when: { severity: [major] }",
      "  - slug: plain",
      "    kind: agent",
      "    prompt: just work",
      "edges:",
      "  - { from: review, to: plain }",
      "",
    ].join("\n"),
  );

  test("a valid report is stored and the check then passes the node", async () => {
    const { run } = await host(REVIEW).start("t");
    const sent = await run.reportResult("review", 1, {
      completeness: "complete",
      rows: [{ severity: "minor", note: "nit" }],
    });
    expect(sent).toEqual({ ok: true });
    await run.completeStep("review", 1);
    const state = await finish(run);
    expect(state.nodes.review?.status).toBe("passed");
    expect(state.trail).toEqual(["review", "plain"]);
  });

  test("a blocking finding fails the node, and no report fails it too", async () => {
    const h = host(REVIEW);
    const { run } = await h.start("t");
    await run.reportResult("review", 1, {
      completeness: "complete",
      rows: [{ severity: "major", note: "bad" }],
    });
    await run.completeStep("review", 1);
    const state = await finish(run);
    expect(state.nodes.review).toMatchObject({ status: "rework", attempt: 2 });
    expect(state.nodes.review?.lastFailure?.reason).toContain("1 blocking finding");
    await run.completeStep("review", 2); // no report for this attempt
    const after = await finish(run);
    expect(after.nodes.review?.lastFailure?.reason).toContain("no result was reported");
  });

  test("a rejected report is explained and not stored", async () => {
    const h = host(REVIEW);
    const { run } = await h.start("t");
    const sent = await run.reportResult("review", 1, {
      completeness: "complete",
      rows: [{ severity: "huge", note: "x" }],
    });
    expect(sent).toMatchObject({ ok: false, code: "INVALID_RESULT_ROWS" });
    expect(await h.store.readReport(run.runId, "review", 1)).toBeUndefined();
  });

  test("the node and the attempt must be right", async () => {
    const { run } = await host(REVIEW).start("t");
    const report = { completeness: "complete", rows: [] };
    expect(await run.reportResult("ghost", 1, report)).toMatchObject({
      ok: false,
      code: "UNKNOWN_NODE",
    });
    expect(await run.reportResult("plain", 1, report)).toMatchObject({
      ok: false,
      code: "NODE_NOT_RUNNING",
    });
    expect(await run.reportResult("review", 4, report)).toMatchObject({
      ok: false,
      code: "ATTEMPT_MISMATCH",
    });
  });

  test("a node without a result check does not take a report", async () => {
    const { run } = await host(REVIEW).start("t");
    await run.reportResult("review", 1, { completeness: "complete", rows: [] });
    await run.completeStep("review", 1);
    await run.settle();
    const sent = await run.reportResult("plain", 1, { completeness: "complete", rows: [] });
    expect(sent).toMatchObject({ ok: false, code: "PIPELINE_INVALID" });
  });

  test("a secret in a report is redacted on disk", async () => {
    const h = host(REVIEW);
    const { run } = await h.start("t");
    await run.reportResult("review", 1, {
      completeness: "complete",
      rows: [{ severity: "minor", note: `found ${secret}` }],
    });
    const text = await readFile(
      join(h.store.runDir(run.runId), "reports", "review-1.json"),
      "utf8",
    );
    expect(text).not.toContain(secret);
  });
});

describe("extending the host", () => {
  test("a check kind from a plugin brings its own runner", async () => {
    const registry = defaultRegistry().registerCheck({ kind: "always-no", shape: {} });
    const spec = parsePipeline(
      [
        "name: plug",
        "nodes:",
        "  - slug: work",
        "    kind: agent",
        "    prompt: x",
        "    checks:",
        "      - { kind: always-no }",
        "",
      ].join("\n"),
      { registry },
    );
    const h = new LocalHost(spec, {
      root: dir,
      heartbeatMs: 0,
      engine: { registry },
      checkRunners: { "always-no": async () => ({ passed: false, reason: "the plugin said no" }) },
    });
    const { run } = await h.start("t");
    await run.completeStep("work", 1);
    const state = await finish(run);
    expect(state.nodes.work?.lastFailure).toEqual({
      source: "check:always-no",
      reason: "the plugin said no",
      check_id: "work/always-no#1",
    });
  });

  test("hp9r_the_journal_of_a_real_run_carries_check_id_and_params_hash", async () => {
    const registry = defaultRegistry().registerCheck({ kind: "always-no", shape: {} });
    const spec = parsePipeline(
      [
        "name: plug",
        "nodes:",
        "  - slug: work",
        "    kind: agent",
        "    prompt: x",
        "    checks:",
        "      - { kind: always-no }",
        "",
      ].join("\n"),
      { registry },
    );
    const h = new LocalHost(spec, {
      root: dir,
      heartbeatMs: 0,
      engine: { registry },
      checkRunners: { "always-no": async () => ({ passed: false, reason: "no" }) },
    });
    const { run } = await h.start("t");
    await run.completeStep("work", 1);
    await finish(run);
    const text = await readFile(join(h.store.runDir(run.runId), "journal.jsonl"), "utf8");
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((r) => r.event === "check_finished");
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r.check_id).toBe("work/always-no#1");
      expect(typeof r.params_hash).toBe("string");
    }
    expect(new Set(records.map((r) => r.params_hash)).size).toBe(1);
  });

  test("a check kind with no runner fails clearly instead of hanging", async () => {
    const registry = defaultRegistry().registerCheck({ kind: "mystery", shape: {} });
    const spec = parsePipeline(
      [
        "name: plug",
        "nodes:",
        "  - slug: work",
        "    kind: agent",
        "    prompt: x",
        "    checks:",
        "      - { kind: mystery }",
        "",
      ].join("\n"),
      { registry },
    );
    const { run } = await new LocalHost(spec, {
      root: dir,
      heartbeatMs: 0,
      engine: { registry },
    }).start("t");
    await run.completeStep("work", 1);
    const state = await finish(run);
    expect(state.nodes.work?.lastFailure?.reason).toContain(
      'no runner for the check kind "mystery"',
    );
  });
});

describe("a process that dies", () => {
  test("its work is restarted by a later tick, from nothing but the files", async () => {
    let now = 1_000_000;
    const spec = parsePipeline(
      [
        "name: hangs",
        "nodes:",
        "  - slug: a",
        "    kind: command",
        `    command: node -e "setTimeout(() => {}, 60000)"`,
        "  - slug: b",
        "    kind: command",
        `    command: node -e "0"`,
        "edges:",
        "  - { from: a, to: b }",
        "  - { from: a, to: b, when: failed }",
        "  - { from: b, to: a, when: failed }",
        "",
      ].join("\n"),
    );
    const h = host(spec, { clock: () => now });
    const { run } = await h.start("t");
    expect((await run.state()).nodes.a?.status).toBe("running");
    run.stop(); // the process dies
    await run.settle();

    now += 31_000;
    const revived = host(spec, { clock: () => now }).open(run.runId);
    await revived.tick();
    const events = (await h.store.readJournal(run.runId)).map((r) => r.event);
    expect(events).toContain("node_restarted");
    expect((await revived.state()).nodes.a).toMatchObject({ status: "running", attempt: 1 });
    revived.stop();
    await revived.settle();
  });
});
