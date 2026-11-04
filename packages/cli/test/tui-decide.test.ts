/**
 * Deciding a gate or a pause from the terminal UI (TASK-DXN6), on real runs: the model is driven
 * with keys, and what it asks for (the checks, the write) is done by the same tools the loop uses.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChangeReport, LocalPipelineHost, type LocalRun } from "@kodel-ai/local";
import { runCli } from "../src/cli";
import { stripAnsi } from "../src/tui/ansi";
import { createDecisionTools, type DecisionTools, decisionOptions } from "../src/tui/decide";
import { demoSessions } from "../src/tui/demo";
import { loadRunDetail } from "../src/tui/gate";
import { loadSessions } from "../src/tui/load";
import { applyInput, runTui } from "../src/tui/run";
import type { CheckResult } from "../src/tui/session";
import {
  detailKey,
  initialModel,
  type Model,
  pickedDecision,
  render,
  takeEffects,
  update,
  withCheck,
  withData,
  withDecided,
  withDetail,
} from "../src/tui/view";

let dir: string;

/** A step, then a gate that records comments; a rejection sends the run back to the step. */
const ONE = [
  "name: one",
  "nodes:",
  "  - { slug: write, kind: agent, prompt: write }",
  "  - slug: approve",
  "    kind: human",
  "    prompt: fine?",
  "    results:",
  "      columns: { place: text, problem: longtext }",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

/** Two agent branches, each ending at a gate, meeting at a join. */
const GATES = [
  "name: gates",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: a }",
  "  - { slug: a-gate, kind: human, prompt: a looks fine? }",
  "  - { slug: b, kind: agent, prompt: b }",
  "  - { slug: b-gate, kind: human, prompt: b looks fine? }",
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: a-gate }",
  "  - { from: a-gate, to: merge, when: approved }",
  "  - { from: a-gate, to: a, when: rejected }",
  "  - { from: b, to: b-gate }",
  "  - { from: b-gate, to: merge, when: approved }",
  "  - { from: b-gate, to: b, when: rejected }",
  "",
].join("\n");

/** A command that fails pauses the whole run; the resume takes the way on. */
const PAUSED = [
  "name: paused",
  "nodes:",
  "  - { slug: write, kind: agent, prompt: write }",
  `  - { slug: check, kind: command, command: "node -e \\"process.exit(1)\\"", max_consecutive_failures: 1 }`,
  `  - { slug: done, kind: command, command: "node -e \\"process.exit(0)\\"" }`,
  "edges:",
  "  - { from: write, to: check }",
  "  - { from: check, to: done, when: failed }",
  "  - { from: done, to: write, when: failed }",
  "",
].join("\n");

/** Two command branches that fail at once and pause their branches; an agent branch moves beside them. */
const BESIDE = [
  "name: beside",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: a }",
  `  - { slug: b, kind: command, command: "node -e \\"process.exit(1)\\"", max_attempts: 1, max_consecutive_failures: 1 }`,
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
  "",
].join("\n");

/** A gate in one branch; in the other a command that fails and pauses its branch. */
const GATE_PAUSE = [
  "name: gate-pause",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: a }",
  "  - { slug: a-gate, kind: human, prompt: a looks fine? }",
  `  - { slug: b, kind: command, command: "node -e \\"process.exit(1)\\"", max_attempts: 1, max_consecutive_failures: 1 }`,
  `  - { slug: b-fix, kind: command, command: "node -e \\"process.exit(1)\\"" }`,
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: a-gate }",
  "  - { from: a-gate, to: merge, when: approved }",
  "  - { from: a-gate, to: a, when: rejected }",
  "  - { from: b, to: merge }",
  "  - { from: b, to: b-fix, when: failed }",
  "  - { from: b-fix, to: merge }",
  "  - { from: b-fix, to: b, when: failed }",
  "",
].join("\n");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-tui-decide-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  for (const [name, text] of [
    ["one", ONE],
    ["gates", GATES],
    ["paused", PAUSED],
    ["beside", BESIDE],
    ["gate-pause", GATE_PAUSE],
  ]) {
    await writeFile(join(dir, ".kodel", "pipelines", `${name}.yaml`), text as string);
  }
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const host = () => new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
const NOW = Date.now();

/** A command as a person at a terminal who says yes. */
async function cli(...args: string[]) {
  let out = "";
  let err = "";
  const code = await runCli(args, {
    cwd: dir,
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    interactive: true,
    environment: {},
    select: async () => [],
    confirm: async () => true,
  });
  return { code, out, err };
}

async function start(h: LocalPipelineHost, pipeline: string, task = "t"): Promise<LocalRun> {
  return (await h.start({ pipeline, task, restart: false })).run as LocalRun;
}

/** The `one` pipeline waiting at its gate. */
async function atGate(h: LocalPipelineHost, task = "t"): Promise<LocalRun> {
  const run = await start(h, "one", task);
  await run.completeStep("write", 1);
  await run.waitForRest(5_000);
  return run;
}

/** The `gates` pipeline at both gates. */
async function atBothGates(h: LocalPipelineHost): Promise<LocalRun> {
  const run = await start(h, "gates");
  await run.completeStep("plan", 1);
  await run.completeStep("a", 1);
  await run.completeStep("b", 1);
  await run.waitForRest(5_000);
  return run;
}

async function modelOf(h: LocalPipelineHost, selected?: string): Promise<Model> {
  const m = initialModel(await loadSessions(h, Date.now()), "project", Date.now());
  return selected === undefined ? m : { ...m, selected };
}

/** Does what the model asked for, as the loop does, until it asks for nothing more. */
async function settle(m: Model, tools: DecisionTools): Promise<Model> {
  let model = m;
  for (;;) {
    const [clean, effects] = takeEffects(model);
    model = clean;
    if (effects.length === 0) return model;
    for (const effect of effects) {
      if (effect.type === "check_decision") {
        model = withCheck(model, effect.flow, await tools.check(effect.runId, effect));
      } else if (effect.type === "decide") {
        model = withDecided(model, effect.flow, await tools.decide(effect.runId, effect));
      }
    }
  }
}

/** Keys, one after another, each followed by what it asked for. */
async function press(m: Model, tools: DecisionTools, ...keys: string[]): Promise<Model> {
  let model = m;
  for (const key of keys) model = await settle(update(model, key), tools);
  return model;
}

const record = async (run: LocalRun, event: string) =>
  (await run.journal()).filter((r) => r.event === event);

describe("task_dxn6 approve and reject from the TUI", () => {
  test("task_dxn6_tui_approve_writes_decision_and_run_goes_on", async () => {
    const h = host();
    const run = await atGate(h);
    const tools = createDecisionTools(h);
    let m = await modelOf(h, run.runId);
    expect(m.sessions[0]?.decisions?.map((d) => d.node)).toEqual(["approve"]);
    m = await press(m, tools, "a");
    expect(m.flow?.phase).toBe("confirm");
    expect(m.flow?.questions[0]).toContain(`Approve "approve" of run ${run.runId}?`);
    // nothing is written until the yes
    expect((await run.state()).active.map((v) => v.phase)).toEqual(["human"]);
    m = await press(m, tools, "y");
    expect(m.flow).toBeNull();
    expect(m.notice).toBe("Approved «approve».");
    expect((await run.state()).status).toBe("completed");
  });

  test("task_dxn6_tui_approve_writes_decision_and_the_list_reloads_at_once", async () => {
    const h = host();
    const run = await atGate(h);
    const tools = createDecisionTools(h);
    const t = terminal();
    const done = runTui(t.stdin, t.stdout, () => loadSessions(h, Date.now()), "project", {
      // a timer tick would take a minute: what shows the decision is the read made right after it
      refreshMs: 60_000,
      loadDetail: (id, pick) => loadRunDetail(h, id, Date.now(), pick),
      ...decisionOptions("project", tools),
    });
    await until(() => t.since().includes("WAITING FOR YOU"));
    t.type("a");
    await until(() => t.since().includes("Approve"));
    t.type("y");
    await until(() => t.since().includes("Approved «approve»."));
    const mark = t.mark();
    await until(() => !t.since(mark).includes("WAITING FOR YOU") || t.since(mark).includes("done"));
    expect((await run.state()).status).toBe("completed");
    t.type("q");
    await done;
  });

  test("task_dxn6_tui_reject_takes_recorded_comments", async () => {
    const h = host();
    const run = await atGate(h);
    await run.reportResult("approve", 1, {
      rows: [{ place: "a.ts", problem: "too big\u001b[2J" }],
    });
    const tools = createDecisionTools(h);
    let m = await press(await modelOf(h, run.runId), tools, "r");
    expect(m.flow?.phase).toBe("confirm");
    expect(m.flow?.questions[0]).toContain("1 comment(s) recorded at this step");
    expect(m.flow?.questions[0]).toContain("a.ts,too big");
    expect(m.flow?.questions[0]).not.toContain("\u001b");
    m = await press(m, tools, "y");
    expect(m.notice).toBe("Rejected «approve».");
    const state = await run.state();
    expect(state.active.map((v) => v.node)).toEqual(["write"]);
    expect(JSON.stringify(await run.nextStep())).toContain("a.ts,too big");
  });

  test("task_dxn6_reject_needs_reason_or_comments", async () => {
    const h = host();
    const run = await atGate(h);
    const tools = createDecisionTools(h);
    let m = await press(await modelOf(h, run.runId), tools, "r");
    expect(m.flow?.phase).toBe("reason");
    // whitespace is no reason, and nothing is written
    m = await press(m, tools, " ", " ", "enter");
    expect(m.flow).toBeNull();
    expect(m.notice).toContain("needs a reason");
    expect((await run.state()).active.map((v) => v.phase)).toEqual(["human"]);
    // Esc writes nothing either
    m = await press(m, tools, "r", "x", "escape");
    expect(m.flow).toBeNull();
    expect((await run.state()).active.map((v) => v.phase)).toEqual(["human"]);
    // a reason is checked again, then asked
    m = await press(m, tools, "r", " ", "t", "o", "o", " ", "b", "i", "g", "enter");
    expect(m.flow?.phase).toBe("confirm");
    m = await press(m, tools, "y");
    expect(m.notice).toBe("Rejected «approve».");
    expect((await record(run, "gate_decided"))[0]?.reason).toBe("too big");
  });
});

describe("task_dxn6 refusals", () => {
  const edit = (name: string) =>
    writeFile(
      join(dir, ".kodel", "pipelines", `${name}.yaml`),
      ONE.replace("write }", "write2 }").replace("name: one", `name: ${name}`),
    );

  test("task_dxn6_refuses_while_pipeline_change_pending", async () => {
    const h = host();
    const run = await atGate(h);
    const tools = createDecisionTools(h);
    // The screen was read before the file was edited: the check refuses in words.
    const before = await modelOf(h, run.runId);
    await edit("one");
    const m = await press(before, tools, "a");
    expect(m.flow).toBeNull();
    expect(m.notice).toContain("a change of the pipeline");
    expect((await run.state()).active.map((v) => v.phase)).toEqual(["human"]);
    // Read again, the run itself says a change waits: the key then names the command.
    const after = await press(await modelOf(h, run.runId), tools, "a");
    expect(after.flow).toBeNull();
    expect(after.notice).toContain("kodel pipeline changes apply");
    expect((await run.state()).active.map((v) => v.phase)).toEqual(["human"]);
  });

  test("a change that arrives after the question is refused at the yes", async () => {
    const h = host();
    const run = await atGate(h);
    const tools = createDecisionTools(h);
    let m = await press(await modelOf(h, run.runId), tools, "a");
    expect(m.flow?.phase).toBe("confirm");
    await edit("one");
    m = await press(m, tools, "y");
    expect(m.notice).toContain("a change of the pipeline");
    expect((await run.state()).active.map((v) => v.phase)).toEqual(["human"]);
  });

  test("task_dxn6_refuses_wrong_attempt_at_check_and_at_write", async () => {
    const h = host();
    const run = await atGate(h);
    const tools = createDecisionTools(h);
    // The question is on the screen for attempt 1 ...
    let m = await press(await modelOf(h, run.runId), tools, "a");
    expect(m.flow?.ref.attempt).toBe(1);
    const stale = m;
    // ... meanwhile the gate is rejected elsewhere and reached again as attempt 2.
    expect((await cli("gate", "reject", run.runId, "--reason", "again")).code).toBe(0);
    await run.completeStep("write", 2);
    await run.waitForRest(5_000);
    expect((await run.state()).active[0]?.attempt).toBe(2);
    m = await press(m, tools, "y");
    expect(m.notice).toContain("no longer waiting for this decision");
    expect((await run.state()).active.map((v) => v.phase)).toEqual(["human"]);
    // A screen that still shows attempt 1 is refused at the check.
    const again = await press({ ...stale, flow: null, notice: "" }, tools, "a");
    expect(again.flow).toBeNull();
    expect(again.notice).toContain("no longer at the attempt you looked at");
  });

  test("a gate decided elsewhere between the question and the yes is refused in words", async () => {
    const h = host();
    const run = await atGate(h);
    const tools = createDecisionTools(h);
    let m = await press(await modelOf(h, run.runId), tools, "a");
    expect((await cli("gate", "approve", run.runId)).code).toBe(0);
    m = await press(m, tools, "y");
    expect(m.flow).toBeNull();
    expect(m.notice).toContain("no longer waiting for this decision");
    expect(await record(run, "gate_decided")).toHaveLength(1);
  });

  test("comments that changed while the question was open are refused, and nothing is written", async () => {
    const h = host();
    const run = await atGate(h);
    await run.reportResult("approve", 1, { rows: [{ place: "a.ts", problem: "one" }] });
    const tools = createDecisionTools(h);
    let m = await press(await modelOf(h, run.runId), tools, "r");
    expect(m.flow?.phase).toBe("confirm");
    await run.reportResult("approve", 1, { rows: [{ place: "b.ts", problem: "two" }] });
    m = await press(m, tools, "y");
    expect(m.notice).toContain("changed while you were reading");
    expect(await record(run, "gate_decided")).toHaveLength(0);
  });

  test("a check that fails to run is a notice, not a crash", async () => {
    const tools = createDecisionTools({
      open: async () => {
        throw new Error("disk gone\u001b[2J");
      },
    });
    const result = await tools.check("r_x", {
      flow: 1,
      ref: { kind: "gate", node: "g", attempt: 1, prompt: "", command: "" },
      decision: "approve",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Could not check");
      expect(result.message).not.toContain("\u001b");
    }
  });
});

describe("task_dxn6 the picker", () => {
  test("task_dxn6_picker_decides_the_picked_decision_of_a_fork", async () => {
    const h = host();
    const run = await atBothGates(h);
    const tools = createDecisionTools(h);
    let m = await modelOf(h, run.runId);
    const session = m.sessions[0];
    expect(session?.decisions?.map((d) => [d.kind, d.node, d.attempt])).toEqual([
      ["gate", "a-gate", 1],
      ["gate", "b-gate", 1],
    ]);
    expect(pickedDecision(m, session as never)?.node).toBe("a-gate");
    m = update(m, "g");
    expect(pickedDecision(m, m.sessions[0] as never)?.node).toBe("b-gate");
    m = update(m, "g"); // wraps
    expect(pickedDecision(m, m.sessions[0] as never)?.node).toBe("a-gate");
    m = update(m, "G"); // and back
    m = await press(m, tools, "a");
    expect(m.flow?.questions[0]).toContain('Approve "b-gate"');
    m = await press(m, tools, "y");
    expect(m.notice).toBe("Approved «b-gate».");
    // the read made right after the write does not take the confirmation away
    m = withData(m, await loadSessions(h, Date.now()), Date.now());
    expect(m.notice).toBe("Approved «b-gate».");
    const decided = await record(run, "gate_decided");
    expect(decided.map((r) => r.node)).toEqual(["b-gate"]);
    // the other gate still waits
    expect((await run.state()).active.map((v) => [v.node, v.phase])).toEqual([["a-gate", "human"]]);
  });

  test("task_dxn6_picker_state_and_card_follow_the_pick", async () => {
    const h = host();
    const run = await atBothGates(h);
    let m = await modelOf(h, run.runId);
    m = update(m, "g");
    const picked = pickedDecision(m, m.sessions[0] as never);
    expect(picked?.node).toBe("b-gate");
    // kept through a refresh
    m = withData(m, await loadSessions(h, Date.now()), Date.now());
    expect(pickedDecision(m, m.sessions[0] as never)?.node).toBe("b-gate");
    // the card is read for the picked gate, with its prompt and without instructions
    const first = await loadRunDetail(h, run.runId, Date.now(), m.sessions[0]?.decisions?.[0]);
    const second = await loadRunDetail(h, run.runId, Date.now(), picked);
    expect(first?.node).toBe("a-gate");
    expect(second?.node).toBe("b-gate");
    expect(second?.attempt).toBe(1);
    expect(second?.prompt).toBe("b looks fine?");
    expect(second?.instructions).toBeUndefined();
    const s = m.sessions[0] as never;
    m = withDetail(m, detailKey(s, m.sessions[0]?.decisions?.[0]), first as never);
    m = withDetail(m, detailKey(s, picked), second as never);
    // a comment goes to the picked gate
    m = { ...m, focus: "card" };
    m = update(m, "c");
    expect(m.input).not.toBeNull();
    for (const key of ["h", "i", "enter"]) m = update(m, key);
    const [, effects] = takeEffects(m);
    expect(effects[0]).toMatchObject({ type: "add_comment", node: "b-gate", attempt: 1 });
    // a pick whose decision is decided elsewhere is dropped, with a notice
    expect((await cli("gate", "approve", run.runId, "--node", "b-gate")).code).toBe(0);
    m = withData(m, await loadSessions(h, Date.now()), Date.now());
    expect(pickedDecision(m, m.sessions[0] as never)?.node).toBe("a-gate");
    expect(m.notice).toContain("had picked is gone");
  });

  test("a comment being typed, or a deletion asked, is cancelled when its card goes", async () => {
    const h = host();
    const run = await atBothGates(h);
    let m = await modelOf(h, run.runId);
    m = update(m, "g");
    const [a, b] = m.sessions[0]?.decisions ?? [];
    const s = m.sessions[0] as never;
    m = withDetail(m, detailKey(s, a), (await loadRunDetail(h, run.runId, Date.now(), a)) as never);
    m = withDetail(m, detailKey(s, b), (await loadRunDetail(h, run.runId, Date.now(), b)) as never);
    m = update({ ...m, focus: "card" }, "c");
    m = update(m, "h");
    expect(m.input?.text).toBe("h");
    // the picked gate is decided in another terminal; the next read drops the pick
    expect((await cli("gate", "approve", run.runId, "--node", "b-gate")).code).toBe(0);
    const typing = withData(m, await loadSessions(h, Date.now()), Date.now());
    expect(typing.input).toBeNull();
    expect(typing.notice).toContain("cancelled");
    // and a comment can no longer be saved onto the other gate by the Enter that follows
    expect(takeEffects(update(typing, "enter"))[1]).toEqual([]);
    // the same for a deletion that was being asked
    const asking = withData(
      { ...m, input: null, confirm: "d" },
      await loadSessions(h, Date.now()),
      Date.now(),
    );
    expect(asking.confirm).toBeNull();
  });

  test("a pick cannot redirect a question that is open, and the keys that move it are ignored then", async () => {
    const h = host();
    const run = await atBothGates(h);
    const tools = createDecisionTools(h);
    let m = await press(await modelOf(h, run.runId), tools, "a");
    expect(m.flow?.ref.node).toBe("a-gate");
    m = update(m, "g"); // any key but y cancels the question: it never moves the pick
    expect(m.flow).toBeNull();
    expect(pickedDecision(m, m.sessions[0] as never)?.node).toBe("a-gate");
    expect(await record(run, "gate_decided")).toHaveLength(0);
  });
});

describe("task_dxn6 resume", () => {
  test("task_dxn6_tui_resume_paused_run", async () => {
    const h = host();
    const run = await start(h, "paused");
    await run.completeStep("write", 1);
    await run.waitForRest(10_000);
    expect((await run.state()).status).toBe("paused");
    const tools = createDecisionTools(h);
    let m = await modelOf(h, run.runId);
    expect(m.sessions[0]?.decisions?.map((d) => [d.kind, d.node])).toEqual([["pause", "check"]]);
    m = await press(m, tools, "a");
    expect(m.flow?.questions[0]).toContain(`Resume run ${run.runId}`);
    m = await press(m, tools, "y");
    expect(m.notice).toBe("Resumed at «check».");
    expect((await record(run, "run_resumed")).map((r) => r.node)).toEqual(["check"]);
    // `r` has no meaning on a pause
    const paused = await start(h, "paused", "again");
    await paused.completeStep("write", 1);
    await paused.waitForRest(10_000);
    const m2 = await press(await modelOf(h, paused.runId), tools, "r");
    expect(m2.flow).toBeNull();
  });

  test("a paused branch beside a branch that moves is not decided by a key; the command is", async () => {
    const h = host();
    const run = await start(h, "beside");
    await run.completeStep("plan", 1);
    await run.waitForRest(10_000);
    const state = await run.state();
    expect(state.status).toBe("running");
    expect(state.pauses.map((p) => p.node)).toEqual(["b"]);
    const tools = createDecisionTools(h);
    const m = await press(await modelOf(h, run.runId), tools, "a");
    expect(m.flow).toBeNull();
    // the card says which command decides it
    const text = render(m, { cols: 120, rows: 30 }).map(stripAnsi).join("\n");
    expect(text).toContain("Also waiting for you");
    // the engine words the command (`--node` only when several branches are paused)
    expect(text).toContain(`$ kodel resume ${run.runId}`);
    expect((await cli("resume", run.runId)).code).toBe(0);
  });
});

describe("task_dxn6 a gate and a paused branch together", () => {
  test("the pause is a picker entry, and the card follows the pick", async () => {
    const h = host();
    const run = await start(h, "gate-pause");
    await run.completeStep("plan", 1);
    await run.completeStep("a", 1);
    await run.waitForRest(10_000);
    const state = await run.state();
    expect(state.pauses.map((p) => p.node)).toEqual(["b"]);
    expect(state.active.map((v) => [v.node, v.phase])).toEqual([["a-gate", "human"]]);
    const tools = createDecisionTools(h);
    let m = await modelOf(h, run.runId);
    expect(m.sessions[0]?.decisions?.map((d) => [d.kind, d.node])).toEqual([
      ["gate", "a-gate"],
      ["pause", "b"],
    ]);
    m = update(m, "g");
    const text = render(m, { cols: 120, rows: 30 }).map(stripAnsi).join("\n");
    expect(text).toContain("decision 2 of 2");
    expect(text).toContain("Paused at «b»");
    expect(text).toContain("$ kodel resume");
    expect(text).not.toContain("kodel gate approve");
    expect(text).not.toContain("Reading the details");
    m = await press(m, tools, "a", "y");
    expect(m.notice).toBe("Resumed at «b».");
    expect((await record(run, "run_resumed")).map((r) => r.node)).toEqual(["b"]);
    await run.waitForRest(10_000);
  });

  test("a gate reached again as a new attempt drops the open question with its own words", async () => {
    const h = host();
    const run = await atGate(h);
    const tools = createDecisionTools(h);
    let m = await press(await modelOf(h, run.runId), tools, "a");
    expect(m.flow?.phase).toBe("confirm");
    expect((await cli("gate", "reject", run.runId, "--reason", "again")).code).toBe(0);
    await run.completeStep("write", 2);
    await run.waitForRest(5_000);
    m = withData(m, await loadSessions(h, Date.now()), Date.now());
    expect(m.flow).toBeNull();
    expect(m.notice).toContain("reached again (a new attempt)");
  });
});

describe("task_dxn6 keys during a decision", () => {
  test("task_dxn6_tui_keys_during_a_decision", async () => {
    const h = host();
    const run = await atGate(h);
    const m0 = await modelOf(h, run.runId);
    // y before the check has come back does nothing
    let m = update(m0, "a");
    expect(m.flow?.phase).toBe("asking");
    m = update(m, "y");
    expect(m.flow?.phase).toBe("asking");
    const [, first] = takeEffects(m);
    expect(first.map((e) => e.type)).toEqual(["check_decision"]);
    // a pasted "ay" stops after the a

    const pasted = applyInput(m0, "ay", { cols: 120, rows: 30 });
    expect(pasted.flow?.phase).toBe("asking");
    expect(takeEffects(pasted)[1].map((e) => e.type)).toEqual(["check_decision"]);
    // two yes in a row write once
    const tools = createDecisionTools(h);
    m = await press(m0, tools, "a");
    m = update(update(m, "y"), "y");
    expect(takeEffects(m)[1].map((e) => e.type)).toEqual(["decide"]);
    // q still leaves while the write is made
    expect(update(m, "q").quit).toBe(true);
  });
});

describe("task_dxn6 the record", () => {
  test("task_dxn6_tui_decision_is_not_told_from_command", async () => {
    const h = host();
    const viaCommand = await atGate(h, "command");
    const viaTui = await atGate(h, "tui");
    expect((await cli("gate", "approve", viaCommand.runId)).code).toBe(0);
    const tools = createDecisionTools(h);
    await press(await modelOf(h, viaTui.runId), tools, "a", "y");
    const norm = async (run: LocalRun) =>
      (await record(run, "gate_decided")).map((r) => ({ ...r, ts: 0, seq: 0 }));
    expect(await norm(viaTui)).toEqual(await norm(viaCommand));
    // and a rejection with a reason
    const c2 = await atGate(h, "command 2");
    const t2 = await atGate(h, "tui 2");
    expect((await cli("gate", "reject", c2.runId, "--reason", "no")).code).toBe(0);
    await press(await modelOf(h, t2.runId), tools, "r", "n", "o", "enter", "y");
    expect(await norm(t2)).toEqual(await norm(c2));
    // a resume
    const p1 = await start(h, "paused", "p1");
    const p2 = await start(h, "paused", "p2");
    for (const p of [p1, p2]) {
      await p.completeStep("write", 1);
      await p.waitForRest(10_000);
    }
    expect((await cli("resume", p1.runId)).code).toBe(0);
    await press(await modelOf(h, p2.runId), tools, "a", "y");
    const resumed = async (run: LocalRun) =>
      (await record(run, "run_resumed")).map((r) => ({ ...r, ts: 0, seq: 0 }));
    expect(await resumed(p2)).toEqual(await resumed(p1));
  });
});

describe("task_dxn6 one function for the command and the screen", () => {
  test("task_dxn6_gate_checks_are_one_function_for_command_and_tui", async () => {
    const h = host();
    const run = await atGate(h);
    const tools = createDecisionTools(h);
    const asked = (decision: "approve" | "reject", node = "approve", reason?: string) =>
      tools.check(run.runId, {
        flow: 1,
        ref: { kind: "gate", node, attempt: 1, prompt: "", command: "" },
        decision,
        ...(reason === undefined ? {} : { reason }),
      });
    // a rejection with neither reason nor comments
    const noReason = await asked("reject");
    expect(noReason).toMatchObject({ ok: false, needsReason: true });
    expect((await cli("gate", "reject", run.runId)).err).toContain(refusal(noReason));
    // a step that is not waiting
    const wrong = await asked("approve", "write");
    expect((await cli("gate", "approve", run.runId, "--node", "write")).err).toContain(
      refusal(wrong),
    );
    // a change of the pipeline that waits
    await writeFile(
      join(dir, ".kodel", "pipelines", "one.yaml"),
      ONE.replace("write }", "write2 }"),
    );
    const pending = await asked("approve");
    // the screen words it without the flag it does not have; the rest is the command's own text
    const head = refusal(pending).split(" To decide here")[0] ?? "";
    expect((await cli("gate", "approve", run.runId)).err).toContain(head);
    expect(refusal(pending)).not.toContain("--ignore-pending-change");
  });

  test("the screen and the commands import the checks from the one module (a source check)", async () => {
    const shared = await import("../src/gate-decision");
    const text = await Bun.file(join(import.meta.dir, "../src/tui/decide.ts")).text();
    const command = await Bun.file(join(import.meta.dir, "../src/cli.ts")).text();
    for (const name of [
      "prepareGateDecision",
      "commitGateDecision",
      "prepareResume",
      "commitResume",
    ]) {
      expect(typeof (shared as Record<string, unknown>)[name]).toBe("function");
      expect(text).toContain(name);
      expect(command).toContain(name);
    }
    expect(text).toContain('from "../gate-decision"');
    expect(command).toContain('from "./gate-decision"');
  });
});

describe("task_dxn6 changes that cannot be checked, and a run of another checkout", () => {
  const gateRef = { kind: "gate" as const, node: "g", attempt: 1, prompt: "", command: "" };

  function fakeRun(over: {
    changes?: ChangeReport | (() => ChangeReport);
    foreign?: string;
    calls?: string[];
  }) {
    return {
      runId: "r_fake",
      foreignRoot: async () => over.foreign,
      state: async () =>
        ({
          status: "running",
          active: [{ node: "g", phase: "human", attempt: 1 }],
          pauses: [],
        }) as never,
      pendingChange: async () => undefined,
      changesSinceGate: async () => {
        const c = over.changes ?? { kind: "changes" as const, files: {} };
        return typeof c === "function" ? c() : c;
      },
      gateResults: async () => undefined,
      decideHuman: async () => {
        over.calls?.push("decide");
        return { ok: true } as never;
      },
      resume: async () => ({ ok: true }) as never,
      waitForRest: async () => undefined,
      settle: async () => undefined,
    };
  }

  const modelFor = () =>
    initialModel(
      {
        sessions: [
          {
            id: "r_fake",
            title: "fake",
            pipeline: "p",
            status: "waiting",
            need: "approve",
            step: "approve",
            since: NOW,
            steps: [],
            log: [],
            decisions: [gateRef],
          },
        ],
        proposals: 0,
      },
      "project",
      NOW,
    );

  test("task_dxn6_unavailable_changes_need_second_yes", async () => {
    const calls: string[] = [];
    const unavailable: ChangeReport = { kind: "unavailable", reason: "git failed" };
    const tools = createDecisionTools({
      open: async () => fakeRun({ changes: unavailable, calls }),
    });
    let m = await press(modelFor(), tools, "a");
    expect(m.flow?.questions).toHaveLength(2);
    expect(m.flow?.questions[0]).toContain("WARNING");
    // the first yes asks the second question and writes nothing
    m = await press(m, tools, "y");
    expect(m.flow?.at).toBe(1);
    expect(calls).toEqual([]);
    // a pasted "yy" does not answer the second question unseen, nor does "yq" drop the write
    const fresh = await press(modelFor(), tools, "a");
    const pasted = applyInput(fresh, "yy", { cols: 120, rows: 30 });
    expect(pasted.flow?.at).toBe(1);
    expect(takeEffects(pasted)[1]).toEqual([]);
    const last = applyInput(m, "yq", { cols: 120, rows: 30 });
    expect(last.quit).toBe(false);
    expect(takeEffects(last)[1].map((e) => e.type)).toEqual(["decide"]);
    // n at the second question writes nothing
    const cancelled = await press(m, tools, "n");
    expect(cancelled.flow).toBeNull();
    expect(calls).toEqual([]);
    // the second yes writes
    m = await press(m, tools, "y");
    expect(calls).toEqual(["decide"]);
    expect(m.notice).toBe("Approved «g».");
  });

  test("the shared-tree note keeps a decision whose files moved; without it they are refused", async () => {
    const shown: ChangeReport = {
      kind: "changes",
      files: { "a.ts": 1 },
      note: "other branches ran",
    };
    const moved: ChangeReport = {
      kind: "changes",
      files: { "a.ts": 9 },
      note: "other branches ran",
    };
    let calls = 0;
    const calls1: string[] = [];
    const tools = createDecisionTools({
      open: async () => fakeRun({ changes: () => (++calls === 1 ? shown : moved), calls: calls1 }),
    });
    const m = await press(await press(modelFor(), tools, "a"), tools, "y");
    expect(calls1).toEqual(["decide"]);
    expect(m.notice).toBe("Approved «g».");
    let again = 0;
    const calls2: string[] = [];
    const strict = createDecisionTools({
      open: async () =>
        fakeRun({
          changes: () =>
            ++again === 1
              ? { kind: "changes", files: { "a.ts": 1 } }
              : { kind: "changes", files: { "a.ts": 9 } },
          calls: calls2,
        }),
    });
    const n = await press(await press(modelFor(), strict, "a"), strict, "y");
    expect(calls2).toEqual([]);
    expect(n.notice).toContain("the files changed while you were reading");
  });

  test("a gate on a run of another checkout is allowed, and the sentence is part of the question", async () => {
    const tools = createDecisionTools({ open: async () => fakeRun({ foreign: "/other/clone" }) });
    const m = await press(modelFor(), tools, "a");
    expect(m.flow?.phase).toBe("confirm");
    expect(m.flow?.questions[0]).toContain("was made by the checkout at /other/clone");
  });
});

describe("task_dxn6 sample data", () => {
  test("task_dxn6_demo_decisions_stay_simulated", async () => {
    expect(decisionOptions("demo", createDecisionTools(host()))).toEqual({});
    const demo = initialModel(demoSessions(NOW), "demo", NOW);
    const gate = demo.sessions.find((s) => s.need === "approve");
    let m = { ...demo, selected: gate?.id ?? "" };
    m = update(m, "a");
    expect(m.confirm).toBe("a");
    expect(m.flow).toBeNull();
    m = update(m, "y");
    expect(m.sessions.find((s) => s.id === gate?.id)?.status).toBe("running");
    expect(takeEffects(m)[1]).toEqual([]);
  });
});

describe("task_dxn6 leaving while the work of a decision goes on", () => {
  /** A run that decides at once and whose work ends when the test lets it. */
  function slowRun(release: Promise<void>, counts: { starts: number }) {
    return {
      runId: "r_slow",
      state: async () =>
        ({
          status: "running",
          active: [{ node: "g", phase: "human", attempt: 1 }],
          pauses: [],
        }) as never,
      pendingChange: async () => undefined,
      changesSinceGate: async () => ({ kind: "changes", files: {} }) as never,
      gateResults: async () => undefined,
      decideHuman: async () => {
        counts.starts += 1;
        return { ok: true } as never;
      },
      resume: async () => ({ ok: true }) as never,
      waitForRest: async () => release,
      settle: async () => release,
    };
  }
  const request = {
    flow: 1,
    ref: { kind: "gate" as const, node: "g", attempt: 1, prompt: "", command: "" },
    decision: "approve" as const,
  };

  test("task_dxn6_quit_waits_for_the_work_of_a_decision", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const counts = { starts: 0 };
    const run = slowRun(gate, counts);
    const stops: string[] = [];
    const tools = createDecisionTools(
      { open: async () => run },
      {
        waitMs: 5_000,
        hardStop: async () => {
          stops.push("stop");
        },
      },
    );
    expect(tools.work.pending()).toBe(false);
    expect((await tools.check("r_slow", request)).ok).toBe(true);
    expect((await tools.decide("r_slow", request)).ok).toBe(true);
    expect(counts.starts).toBe(1);
    expect(tools.work.pending()).toBe(true);

    // the screen: q does not leave until the work ends
    const t = terminal();
    const done = runTui(t.stdin, t.stdout, async () => demoSessions(NOW), "demo", {
      work: tools.work,
    });
    let left = false;
    void done.then(() => {
      left = true;
    });
    await until(() => t.since().includes("WAITING FOR YOU"));
    t.type("q");
    await until(() => t.since().includes("Finishing the work of the run"));
    await wait(60);
    expect(left).toBe(false);
    release();
    expect(await done).toBe(0);
    expect(stops).toEqual([]);
    expect(counts.starts).toBe(1);
  });

  test("a second q stops the work and leaves", async () => {
    const forever = new Promise<void>(() => undefined);
    const counts = { starts: 0 };
    const stops: string[] = [];
    const tools = createDecisionTools(
      { open: async () => slowRun(forever, counts) },
      {
        waitMs: 60_000,
        stopWaitMs: 50,
        hardStop: async () => {
          stops.push("stop");
        },
      },
    );
    await tools.check("r_slow", request);
    await tools.decide("r_slow", request);
    const t = terminal();
    const done = runTui(t.stdin, t.stdout, async () => demoSessions(NOW), "demo", {
      work: tools.work,
    });
    await until(() => t.since().includes("WAITING FOR YOU"));
    t.type("q");
    await until(() => t.since().includes("Finishing the work of the run"));
    t.type("q");
    expect(await done).toBe(0);
    expect(stops).toEqual(["stop"]);
  });

  test("a write in flight is waited for, and two runs are both waited for", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waited: string[] = [];
    const make = (id: string) => ({
      ...slowRun(Promise.resolve(), { starts: 0 }),
      runId: id,
      decideHuman: async () => {
        await hold;
        return { ok: true } as never;
      },
      waitForRest: async () => {
        waited.push(id);
      },
    });
    const runs: Record<string, ReturnType<typeof make>> = {
      r_one: make("r_one"),
      r_two: make("r_two"),
    };
    const tools = createDecisionTools({ open: async (id) => runs[id] });
    for (const id of ["r_one", "r_two"])
      await tools.check(id, { ...request, flow: id === "r_one" ? 1 : 2 });
    const first = tools.decide("r_one", request);
    const second = tools.decide("r_two", { ...request, flow: 2 });
    expect(tools.work.pending()).toBe(true);
    let waiting = true;
    const all = tools.work.wait().then(() => {
      waiting = false;
    });
    await wait(40);
    expect(waiting).toBe(true); // the writes are still being made
    release();
    await Promise.all([first, second, all]);
    expect(waited.sort()).toEqual(["r_one", "r_two"]);
  });
});

describe("task_dxn6 the checks are not shown without a decision tool", () => {
  test("a project screen with no tools says it cannot decide here", async () => {
    const h = host();
    const run = await atGate(h);
    const t = terminal();
    const done = runTui(t.stdin, t.stdout, () => loadSessions(h, Date.now()), "project", {
      loadDetail: (id, pick) => loadRunDetail(h, id, Date.now(), pick),
    });
    await until(() => t.since().includes("WAITING FOR YOU"));
    t.type("a");
    await until(() => t.since().includes("Cannot decide here."));
    expect((await run.state()).active.map((v) => v.phase)).toEqual(["human"]);
    t.type("q");
    await done;
  });

  test("the card names how many decisions wait and which is picked", async () => {
    const h = host();
    const run = await atBothGates(h);
    let m = await modelOf(h, run.runId);
    const card = await loadRunDetail(h, run.runId, Date.now(), m.sessions[0]?.decisions?.[0]);
    m = withDetail(
      m,
      detailKey(m.sessions[0] as never, m.sessions[0]?.decisions?.[0]),
      card as never,
    );
    const text = render(m, { cols: 120, rows: 30 }).map(stripAnsi).join("\n");
    expect(text).toContain("decision 1 of 2");
    expect(text).toContain("approve ×2");
  });
});

// helpers for the loop

/** The words of a refusal; a check that did not refuse fails the test. */
function refusal(result: CheckResult): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.message;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, ms = 4_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting for the screen");
    await wait(15);
  }
}

/** A terminal that keeps what is written to it and lets a test type. */
function terminal(cols = 120, rows = 32) {
  const written: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => undefined,
    setEncoding: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
  });
  const stdout = Object.assign(new EventEmitter(), {
    columns: cols,
    rows,
    write: (text: string) => {
      written.push(text);
      return true;
    },
  });
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    type: (input: string) => stdin.emit("data", input),
    since: (mark = 0) => stripAnsi(written.slice(mark).join("")),
    mark: () => written.length,
  };
}
