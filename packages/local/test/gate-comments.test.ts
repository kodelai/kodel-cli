import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PipelineSpec, parsePipeline, validatePipeline } from "@kodel-ai/pipeline-core";
import { LocalHost, type LocalRun } from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-gate-comments-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

const SOURCE = [
  "name: planning",
  "nodes:",
  "  - slug: plan",
  "    kind: agent",
  "    prompt: write the plan",
  "  - slug: approval",
  "    kind: human",
  "    prompt: is the plan right?",
  "    results:",
  "      columns: { place: text, problem: longtext }",
  "  - slug: impl",
  "    kind: agent",
  "    prompt: build it",
  "  - slug: review",
  "    kind: agent",
  "    prompt: review it",
  "    checks:",
  "      - kind: result",
  "        columns: { note: text }",
  "edges:",
  "  - { from: plan, to: approval }",
  "  - { from: approval, to: impl, when: approved }",
  "  - { from: approval, to: plan, when: rejected }",
  "  - { from: impl, to: review }",
  "",
].join("\n");

const host = (spec: PipelineSpec = parsePipeline(SOURCE)) =>
  new LocalHost(spec, { root: dir, heartbeatMs: 0 });

/** A run waiting at the gate with the plan done once. */
async function atGate(h = host()): Promise<LocalRun> {
  const { run } = await h.start("add a limit");
  await run.completeStep("plan", 1);
  await run.settle();
  return run;
}

const comment = (place: string, problem: string) => ({ place, problem });

describe("gate_comments: recording the person's comments at a human step", () => {
  test("gate_comments_the_step_says_what_to_record_and_where", async () => {
    const run = await atGate();
    const step = await run.nextStep();
    if (!("waiting" in step)) throw new Error("expected a gate");
    expect(step.waiting).toMatchObject({
      node_slug: "approval",
      attempt: 1,
      result_spec: { columns: { place: "text", problem: "longtext" } },
    });
    expect(step.waiting.tell_the_person).toContain("pipeline_report_result");
    expect(step.waiting.results).toBeUndefined();
  });

  test("gate_comments_calls_add_up_and_the_step_shows_them", async () => {
    const run = await atGate();
    expect(
      await run.reportResult("approval", 1, { rows: [comment("plan.md:3", "too vague")] }),
    ).toEqual({ ok: true });
    await run.reportResult("approval", 1, { rows: [comment("plan.md:9", 'no "tests"')] });
    // the same call again changes nothing
    await run.reportResult("approval", 1, { rows: [comment("plan.md:9", 'no "tests"')] });
    const step = await run.nextStep();
    if (!("waiting" in step)) throw new Error("expected a gate");
    expect(step.waiting.results).toBe(
      'place,problem\nplan.md:3,too vague\nplan.md:9,"no ""tests"""',
    );
  });

  test("gate_comments_replace_starts_the_list_over", async () => {
    const run = await atGate();
    await run.reportResult("approval", 1, { rows: [comment("a", "one")] });
    await run.reportResult("approval", 1, { rows: [comment("b", "two")] }, { replace: true });
    expect(await run.gateResults("approval")).toEqual({ csv: "place,problem\nb,two", count: 1 });
  });

  test("gate_comments_are_taken_only_while_the_step_waits_and_only_if_it_asks_for_them", async () => {
    const h = host();
    const { run } = await h.start("t");
    // the plan step is running, not a human step
    expect(await run.reportResult("plan", 1, { rows: [] })).toMatchObject({
      ok: false,
      code: "PIPELINE_INVALID",
    });
    await run.completeStep("plan", 1);
    await run.settle();
    expect(await run.reportResult("approval", 1, { rows: [comment("a", "b")] })).toEqual({
      ok: true,
    });
    expect(await run.reportResult("approval", 2, { rows: [] })).toMatchObject({
      ok: false,
      code: "ATTEMPT_MISMATCH",
    });
    // a comment must fit the declared columns
    expect(await run.reportResult("approval", 1, { rows: [{ place: "a" }] })).toMatchObject({
      ok: false,
      code: "MISSING_REQUIRED_VALUE",
    });
    // no verdict at a gate: a step's findings still need a completeness
    await run.decideHuman("approval", "approved");
    await run.settle();
    await run.completeStep("impl", 1);
    await run.settle();
    expect(await run.reportResult("review", 1, { rows: [{ note: "x" }] })).toMatchObject({
      ok: false,
      code: "MISSING_REQUIRED_VALUE",
    });
  });

  test("gate_comments_a_secret_in_a_comment_does_not_reach_the_files", async () => {
    const h = host();
    const run = await atGate(h);
    await run.reportResult("approval", 1, { rows: [comment("a", `the key is ${secret}`)] });
    await run.decideHuman("approval", "rejected");
    for (const file of ["state.json", "journal.jsonl", join("reports", "approval-1.json")]) {
      const text = await readFile(join(h.store.runDir(run.runId), file), "utf8");
      expect(text, file).not.toContain(secret);
    }
  });
});

describe("gate_comments: rejecting", () => {
  test("gate_comments_a_rejection_without_a_reason_sends_the_comments_back", async () => {
    const run = await atGate();
    await run.reportResult("approval", 1, {
      rows: [comment("plan.md:3", "too vague"), comment("plan.md:9", "no tests")],
    });
    expect((await run.decideHuman("approval", "rejected")).ok).toBe(true);
    await run.settle();
    const step = await run.nextStep();
    if (!("node" in step)) throw new Error("expected the plan step again");
    expect(step.node).toMatchObject({ slug: "plan", attempt: 2 });
    expect(step.node.reentry_feedback).toContain("A person sent this back");
    expect(step.node.reentry_feedback).toContain(
      "place,problem\nplan.md:3,too vague\nplan.md:9,no tests",
    );
  });

  test("gate_comments_the_persons_own_reason_comes_first", async () => {
    const run = await atGate();
    await run.reportResult("approval", 1, { rows: [comment("a", "b")] });
    await run.decideHuman("approval", "rejected", "start from the API");
    await run.settle();
    const reason = (await run.state()).nodes.plan?.lastFailure?.reason ?? "";
    expect(reason.startsWith("start from the API\n\nComments (CSV):\nplace,problem\na,b")).toBe(
      true,
    );
  });

  test("gate_comments_a_rejection_with_nothing_to_say_is_as_before", async () => {
    const run = await atGate();
    await run.decideHuman("approval", "rejected");
    await run.settle();
    expect((await run.state()).nodes.plan?.lastFailure?.reason).toBe("rejected without a reason");
  });

  test("gate_comments_each_attempt_has_its_own_comments", async () => {
    const run = await atGate();
    await run.reportResult("approval", 1, { rows: [comment("a", "old")] });
    await run.decideHuman("approval", "rejected");
    await run.settle();
    await run.completeStep("plan", 2);
    await run.settle();
    expect(await run.gateResults("approval")).toBeUndefined();
    await run.decideHuman("approval", "rejected", "again");
    await run.settle();
    expect((await run.state()).nodes.plan?.lastFailure?.reason).toBe("again");
  });

  test("gate_comments_an_approval_ignores_them", async () => {
    const run = await atGate();
    await run.reportResult("approval", 1, { rows: [comment("a", "b")] });
    expect((await run.decideHuman("approval", "approved")).ok).toBe(true);
    await run.settle();
    expect((await run.state()).trail).toEqual(["plan", "approval", "impl"]);
  });
});

describe("gate_comments: the pipeline file", () => {
  const withResults = (results: string) =>
    SOURCE.replace("      columns: { place: text, problem: longtext }", results);

  test("gate_comments_results_needs_columns_and_knows_no_other_key", () => {
    expect(validatePipeline(withResults("      columns: {}")).ok).toBe(false);
    expect(validatePipeline(withResults("      fail_when: { place: [x] }")).ok).toBe(false);
    expect(validatePipeline(withResults("      columns: { place: text }")).ok).toBe(true);
  });

  test("gate_comments_a_human_step_without_results_takes_no_report", async () => {
    const spec = parsePipeline(
      SOURCE.replace("    results:\n      columns: { place: text, problem: longtext }\n", ""),
    );
    const run = await atGate(host(spec));
    expect(await run.reportResult("approval", 1, { rows: [] })).toMatchObject({
      ok: false,
      code: "PIPELINE_INVALID",
    });
  });
});
