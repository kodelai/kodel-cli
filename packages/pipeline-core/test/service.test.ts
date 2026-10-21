import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type Decision,
  decide,
  type Effect,
  type FeedbackInput,
  type NextStep,
  type PipelineHost,
  type PipelineInfo,
  PipelineService,
  type PipelineSpec,
  parsePipeline,
  nextStep as projectNextStep,
  type RunEvent,
  type RunHandle,
  type RunLocation,
  type RunState,
  type StartOutcome,
  type StepResult,
  validateReport,
} from "../src";
import {
  CONTRACT_VERSION,
  invokeTool,
  registerPipelineTools,
  SERVER_INSTRUCTIONS,
  TOOLS,
} from "../src/mcp";

const feature = parsePipeline(
  readFileSync(new URL("../../../examples/pipelines/feature.yaml", import.meta.url), "utf8"),
);
const other = parsePipeline(
  ["name: other", "nodes:", "  - slug: a", "    kind: agent", "    prompt: x", ""].join("\n"),
);

/** A host that keeps everything in memory and answers effects the simplest way. */
class FakeHost implements PipelineHost {
  readonly runs = new Map<string, FakeRun>();
  failChecksOnAttempt1 = false;
  /** Leave the engine's commands unanswered, so the run stays in the `running` shape. */
  holdCommands = false;
  /** The waits the service asked for, in milliseconds. */
  readonly waited: number[] = [];
  /** What the service asked `start` for. */
  readonly starts: { pipeline: string; task: string; restart: boolean; cwd?: string }[] = [];
  /** Where this host says its runs work, when it has an opinion. */
  location: RunLocation | undefined;
  private count = 0;

  constructor(private readonly specs: PipelineSpec[]) {}

  async list() {
    const pipelines: PipelineInfo[] = this.specs.map((s) => ({
      name: s.name,
      version: s.version,
      ...(s.description === undefined ? {} : { description: s.description }),
    }));
    return { pipelines, problems: [] };
  }

  async resolve(name: string) {
    return this.specs.find((s) => s.name === name);
  }

  async start(input: {
    pipeline: string;
    task: string;
    restart: boolean;
    cwd?: string;
  }): Promise<StartOutcome> {
    this.starts.push(input);
    const spec = this.specs.find((s) => s.name === input.pipeline) as PipelineSpec;
    const active = [...this.runs.values()].find(
      (r) => r.spec.name === input.pipeline && r.task === input.task,
    );
    const status = active?.state_?.status;
    if (active && (status === "running" || status === "paused")) {
      return { status: "reused", run: active };
    }
    if (active && !input.restart) return { status: "terminal", run: active };
    const run = new FakeRun(
      this,
      spec,
      input.task,
      `r_${String(++this.count).padStart(9, "0")}_aaaa`,
    );
    this.runs.set(run.runId, run);
    await run.send({ type: "start", runId: run.runId, task: input.task, specHash: "h" });
    return { status: "started", run, ...(this.location ? { workdir: this.location } : {}) };
  }

  async open(runId: string) {
    return this.runs.get(runId);
  }
}

class FakeRun implements RunHandle {
  state_: RunState | undefined;
  readonly reports = new Map<string, unknown>();

  constructor(
    private readonly host: FakeHost,
    readonly spec: PipelineSpec,
    readonly task: string,
    readonly runId: string,
  ) {}

  async state(): Promise<RunState> {
    return this.state_ as RunState;
  }

  async send(first: RunEvent): Promise<Decision> {
    const queue = [first];
    let firstResult: Decision | undefined;
    while (queue.length > 0) {
      const event = queue.shift() as RunEvent;
      const result = decide(this.spec, this.state_, event, 0);
      firstResult ??= result;
      if (!result.ok) {
        if (event === first) return result;
        throw result.error;
      }
      this.state_ = result.state;
      for (const effect of result.effects) {
        const next = this.answer(effect);
        if (next) queue.push(next);
      }
    }
    return firstResult as Decision;
  }

  private answer(effect: Effect): RunEvent | undefined {
    if (effect.type === "run_command") {
      if (this.host.holdCommands) return undefined;
      return {
        type: "work_finished",
        node: effect.node,
        attempt: effect.attempt,
        passed: true,
        reason: "",
      };
    }
    if (effect.type === "run_check") {
      const passed = !(this.host.failChecksOnAttempt1 && effect.attempt === 1);
      return {
        type: "check_finished",
        node: effect.node,
        attempt: effect.attempt,
        index: effect.index,
        passed,
        reason: passed ? "" : "nothing changed in docs/plans",
      };
    }
    return undefined;
  }

  async nextStep(): Promise<NextStep> {
    return projectNextStep(this.spec, this.state_ as RunState, 0);
  }

  completeStep(node: string, attempt: number, summary?: string, outcome?: string) {
    return this.send({
      type: "agent_completed",
      node,
      attempt,
      ...(summary === undefined ? {} : { summary }),
      ...(outcome === undefined ? {} : { outcome }),
    });
  }

  async reportResult(node: string, attempt: number, raw: unknown): Promise<StepResult> {
    const check = this.spec.nodes
      .find((n) => n.slug === node)
      ?.checks.find((c) => c.kind === "result");
    if (!check) return { ok: false, code: "PIPELINE_INVALID", message: "no result expected" };
    const valid = validateReport(raw, check.params);
    if (!valid.ok) return { ok: false, code: valid.code, message: valid.message };
    this.reports.set(`${node}#${attempt}`, valid.report);
    return { ok: true };
  }

  feedback(input: FeedbackInput) {
    return this.send({ type: "feedback", ...input });
  }

  async waitForRest(ms: number): Promise<void> {
    this.host.waited.push(ms);
  }
}

const service = (specs: PipelineSpec[] = [feature]) => {
  const host = new FakeHost(specs);
  return { host, svc: new PipelineService(host, { waitBudgetMs: 0 }) };
};

const asOk = (result: Awaited<ReturnType<PipelineService["start"]>>) => {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
  return result;
};

describe("reading pipelines", () => {
  test("list shows each pipeline with its name and version", async () => {
    const { svc } = service([feature, other]);
    const result = asOk(await svc.list());
    expect((result.pipelines as PipelineInfo[]).map((p) => p.name)).toEqual(["feature", "other"]);
  });

  test("resolve returns the spec; an unknown name says what exists", async () => {
    const { svc } = service([feature, other]);
    expect(asOk(await svc.resolve({ pipeline: "feature" })).spec).toMatchObject({
      name: "feature",
    });
    const missing = await svc.resolve({ pipeline: "nope" });
    expect(missing).toMatchObject({ ok: false, code: "UNKNOWN_PIPELINE" });
    if (!missing.ok) expect(missing.message).toContain("feature, other");
  });

  test("plan fills the task into the prompts and commands and starts nothing", async () => {
    const { svc, host } = service();
    const result = asOk(await svc.plan({ pipeline: "feature", task: "добавить лимит" }));
    const nodes = result.nodes as {
      slug: string;
      prompt?: string;
      command?: string;
      checks: unknown[];
    }[];
    expect(nodes.find((n) => n.slug === "plan")?.prompt).toContain("docs/plans/dobavit_limit.md");
    expect(nodes.find((n) => n.slug === "build")?.command).toBe("bun run build");
    expect(nodes.find((n) => n.slug === "review")?.checks).toHaveLength(1);
    expect(host.runs.size).toBe(0);
  });
});

describe("starting a run", () => {
  test("with one pipeline the name can be left out", async () => {
    const { svc } = service();
    const result = asOk(await svc.start({ task: "add a limit" }));
    expect(result).toMatchObject({
      reused: false,
      terminal: false,
      next: { node: { slug: "plan", attempt: 1 } },
    });
    expect(typeof result.run_id).toBe("string");
  });

  test("with several pipelines the agent must say which", async () => {
    const { svc } = service([feature, other]);
    expect(await svc.start({ task: "t" })).toMatchObject({ ok: false, code: "PIPELINE_AMBIGUOUS" });
    expect(asOk(await svc.start({ task: "t", pipeline: "other" })).run_id).toBeDefined();
  });

  test("no pipelines, or an unknown one, is UNKNOWN_PIPELINE", async () => {
    expect(await service([]).svc.start({ task: "t" })).toMatchObject({
      ok: false,
      code: "UNKNOWN_PIPELINE",
    });
    expect(await service().svc.start({ task: "t", pipeline: "nope" })).toMatchObject({
      code: "UNKNOWN_PIPELINE",
    });
  });

  test("starting the same task again picks up the active run", async () => {
    const { svc } = service();
    const first = asOk(await svc.start({ task: "same" }));
    const second = asOk(await svc.start({ task: "same" }));
    expect(second.run_id).toBe(first.run_id);
    expect(second.reused).toBe(true);
  });

  test("a finished task is terminal until the user asks to restart", async () => {
    const { svc, host } = service();
    const first = asOk(await svc.start({ task: "t" }));
    const run = host.runs.get(first.run_id as string) as FakeRun;
    await run.completeStep("plan", 1);
    await run.send({ type: "human_decided", node: "plan-approval", decision: "approved" });
    await run.completeStep("impl", 1);
    await run.completeStep("review", 1).catch(() => undefined);
    await run.send({ type: "cancel" });
    const again = asOk(await svc.start({ task: "t" }));
    expect(again).toMatchObject({ terminal: true, reused: false, next: { done: true } });
    expect(again.run_id).toBe(first.run_id);
    const restarted = asOk(await svc.start({ task: "t", restart: true }));
    expect(restarted.run_id).not.toBe(first.run_id);
    expect(restarted.terminal).toBe(false);
  });
});

describe("driving a run", () => {
  test("next_step answers with the node, and an unknown run is UNKNOWN_RUN", async () => {
    const { svc } = service();
    const started = asOk(await svc.start({ task: "t" }));
    expect(asOk(await svc.nextStep({ run_id: started.run_id as string }))).toMatchObject({
      node: { slug: "plan", kind: "agent" },
    });
    expect(await svc.nextStep({ run_id: "nope" })).toMatchObject({
      ok: false,
      code: "UNKNOWN_RUN",
    });
  });

  test("completing a step the checks accept advances the run", async () => {
    const { svc } = service();
    const { run_id } = asOk(await svc.start({ task: "t" }));
    const done = asOk(
      await svc.completeStep({
        run_id: run_id as string,
        node_slug: "plan",
        attempt: 1,
        summary: "planned",
      }),
    );
    expect(done).toMatchObject({
      advanced: true,
      outcome: "passed",
      next: { waiting: { node_slug: "plan-approval" } },
    });
    expect(done.failed_check).toBeUndefined();
  });

  test("a failed check gives the reason and the same node again", async () => {
    const { svc, host } = service();
    host.failChecksOnAttempt1 = true;
    const { run_id } = asOk(await svc.start({ task: "t" }));
    const done = asOk(
      await svc.completeStep({ run_id: run_id as string, node_slug: "plan", attempt: 1 }),
    );
    expect(done.advanced).toBe(false);
    expect(done.outcome).toBe("failed");
    expect(done.failed_check).toEqual({ kind: "diff", reason: "nothing changed in docs/plans" });
    expect(done.next).toMatchObject({
      node: {
        slug: "plan",
        attempt: 2,
        reentry_feedback: expect.stringContaining("nothing changed"),
      },
    });
  });

  test("completing twice is harmless and says it did not advance", async () => {
    const { svc } = service();
    const { run_id } = asOk(await svc.start({ task: "t" }));
    const args = { run_id: run_id as string, node_slug: "plan", attempt: 1 };
    expect(asOk(await svc.completeStep(args)).advanced).toBe(true);
    expect(asOk(await svc.completeStep(args)).advanced).toBe(false);
  });

  test("the engine's refusals come back as codes, not exceptions", async () => {
    const { svc } = service();
    const { run_id } = asOk(await svc.start({ task: "t" }));
    const id = run_id as string;
    expect(await svc.completeStep({ run_id: id, node_slug: "plan", attempt: 5 })).toMatchObject({
      code: "ATTEMPT_MISMATCH",
    });
    expect(await svc.completeStep({ run_id: id, node_slug: "build", attempt: 1 })).toMatchObject({
      code: "NODE_NOT_RUNNING",
    });
    expect(await svc.completeStep({ run_id: id, node_slug: "ghost", attempt: 1 })).toMatchObject({
      code: "UNKNOWN_NODE",
    });
    expect(await svc.completeStep({ run_id: "nope", node_slug: "plan", attempt: 1 })).toMatchObject(
      { code: "UNKNOWN_RUN" },
    );
  });

  test("results: a good report is accepted, a bad one explained", async () => {
    const { svc, host } = service();
    const { run_id } = asOk(await svc.start({ task: "t" }));
    const run = host.runs.get(run_id as string) as FakeRun;
    await run.completeStep("plan", 1);
    await run.send({ type: "human_decided", node: "plan-approval", decision: "approved" });
    await run.completeStep("impl", 1);
    const base = {
      run_id: run_id as string,
      node_slug: "review",
      attempt: 1,
      completeness: "complete",
    };
    expect(
      asOk(
        await svc.reportResult({
          ...base,
          rows: [{ severity: "minor", location: "a.ts:1", description: "nit" }],
        }),
      ),
    ).toEqual({ ok: true });
    expect(
      await svc.reportResult({
        ...base,
        rows: [{ severity: "huge", location: "a.ts:1", description: "x" }],
      }),
    ).toMatchObject({
      ok: false,
      code: "INVALID_RESULT_ROWS",
    });
  });

  test("feedback is recorded with an id, and a bad node is refused", async () => {
    const { svc } = service();
    const { run_id } = asOk(await svc.start({ task: "t" }));
    const sent = asOk(
      await svc.feedback({
        run_id: run_id as string,
        node_slug: "plan",
        category: "unclear_prompt",
        message: "which file?",
      }),
    );
    expect(sent.id).toMatch(/^\d+$/);
    expect(
      await svc.feedback({
        run_id: run_id as string,
        node_slug: "ghost",
        category: "other",
        message: "x",
      }),
    ).toMatchObject({ code: "UNKNOWN_NODE" });
  });
});

describe("finishing a step with one of its other outcomes", () => {
  const withOutcome = parsePipeline(
    [
      "name: plan",
      "nodes:",
      "  - slug: plan",
      "    kind: agent",
      "    prompt: plan it",
      "    outcomes: [nothing_to_change]",
      "  - slug: impl",
      "    kind: agent",
      "    prompt: do it",
      "  - slug: confirm",
      "    kind: human",
      "    prompt: ok to stop?",
      "edges:",
      "  - { from: plan, to: impl }",
      "  - { from: plan, to: confirm, when: nothing_to_change }",
      "  - { from: confirm, to: plan, when: rejected }",
      "",
    ].join("\n"),
  );

  test("the step lists its outcomes, and completing with one goes where that outcome leads", async () => {
    const { svc } = service([withOutcome]);
    const started = asOk(await svc.start({ task: "t" }));
    expect(started.next).toMatchObject({ node: { slug: "plan", outcomes: ["nothing_to_change"] } });
    const done = asOk(
      await svc.completeStep({
        run_id: started.run_id as string,
        node_slug: "plan",
        attempt: 1,
        outcome: "nothing_to_change",
      }),
    );
    expect(done).toMatchObject({
      advanced: true,
      outcome: "nothing_to_change",
      next: { waiting: { reason: "gate", node_slug: "confirm" } },
    });
  });

  test("without an outcome the same step goes on to the work", async () => {
    const { svc } = service([withOutcome]);
    const started = asOk(await svc.start({ task: "t" }));
    const done = asOk(
      await svc.completeStep({ run_id: started.run_id as string, node_slug: "plan", attempt: 1 }),
    );
    expect(done).toMatchObject({ outcome: "passed", next: { node: { slug: "impl" } } });
  });

  test("an outcome the step does not have is refused, with the ones it has", async () => {
    const { svc } = service([withOutcome]);
    const started = asOk(await svc.start({ task: "t" }));
    const refused = await svc.completeStep({
      run_id: started.run_id as string,
      node_slug: "plan",
      attempt: 1,
      outcome: "skip_it_all",
    });
    expect(refused).toMatchObject({ ok: false, code: "UNKNOWN_OUTCOME" });
    if (!refused.ok) expect(refused.message).toContain("nothing_to_change");
    // and the step is still there to be done
    expect(asOk(await svc.nextStep({ run_id: started.run_id as string }))).toMatchObject({
      node: { slug: "plan" },
    });
  });

  test("the tool takes a short label and refuses anything longer", async () => {
    const { svc } = service([withOutcome]);
    const started = asOk(await svc.start({ task: "t" }));
    const run_id = started.run_id as string;
    expect(
      await invokeTool(svc, "pipeline_complete_step", {
        run_id,
        node_slug: "plan",
        attempt: 1,
        outcome: "x".repeat(65),
      }),
    ).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
  });
});

describe("waiting for the engine's work", () => {
  const slowSpec = parsePipeline(
    [
      "name: slow",
      "nodes:",
      "  - slug: build",
      "    kind: command",
      "    command: make",
      "    expected_duration: 90",
      "  - slug: after",
      "    kind: command",
      "    command: echo ok",
      "edges:",
      "  - { from: build, to: after }",
      "  - { from: build, to: after, when: failed }",
      "  - { from: after, to: build, when: failed }",
      "",
    ].join("\n"),
  );

  async function running() {
    const { host, svc } = service([slowSpec]);
    host.holdCommands = true;
    const started = asOk(await svc.start({ task: "t" }));
    expect(started.next).toMatchObject({ running: { active: [{ expected_s: 90 }] } });
    return { host, svc, runId: started.run_id as string };
  }

  test("without wait_s the answer comes at once, with a hint that says how long to wait", async () => {
    const { host, svc, runId } = await running();
    const step = asOk(await svc.nextStep({ run_id: runId }));
    expect(host.waited).toEqual([]);
    expect(JSON.stringify(step)).toContain("wait_s");
  });

  test("with wait_s the service waits that long for the work, then answers again", async () => {
    const { host, svc, runId } = await running();
    host.waited.length = 0;
    await svc.nextStep({ run_id: runId, wait_s: 25 });
    expect(host.waited).toEqual([25_000]);
  });

  test("a wait is never longer than 45 seconds, whatever was asked", async () => {
    const { host, svc, runId } = await running();
    host.waited.length = 0;
    await svc.nextStep({ run_id: runId, wait_s: 5_000 });
    expect(host.waited).toEqual([45_000]);
  });

  test("nothing is waited for when there is nothing to wait for", async () => {
    const { host, svc } = service();
    const started = asOk(await svc.start({ task: "t" })); // waiting on the agent, not running
    host.waited.length = 0;
    await svc.nextStep({ run_id: started.run_id as string, wait_s: 30 });
    expect(host.waited).toEqual([]);
  });

  test("the tool takes whole seconds from 0 to 45 and refuses anything else", async () => {
    const { svc, runId } = await running();
    for (const wait_s of [-1, 46, 1.5, "30"]) {
      expect(await invokeTool(svc, "pipeline_next_step", { run_id: runId, wait_s })).toMatchObject({
        ok: false,
        code: "INVALID_ARGUMENTS",
      });
    }
    expect((await invokeTool(svc, "pipeline_next_step", { run_id: runId, wait_s: 45 })).ok).toBe(
      true,
    );
  });
});

describe("where a run works", () => {
  test("tNN_start_passes_the_agents_cwd_on_and_answers_workdir_null_when_the_host_has_none", async () => {
    const { host, svc } = service();
    const started = await invokeTool(svc, "pipeline_start", { task: "x", cwd: "/work/here" });
    const answer = asOk(started);
    expect(host.starts[0]?.cwd).toBe("/work/here");
    expect(answer.workdir).toBeNull();
    expect(answer).not.toHaveProperty("branch");
    expect(answer).not.toHaveProperty("note");
    // without a cwd the host is not given one
    await invokeTool(svc, "pipeline_start", { task: "y" });
    expect(host.starts[1]).not.toHaveProperty("cwd");
  });

  test("tNN_start_names_the_workdir_the_host_chose_with_its_branch_and_note", async () => {
    const { host, svc } = service();
    host.location = {
      path: "/repo/.kodel/worktrees/r_1",
      branch: "kodel/r_1",
      note: "starts from HEAD",
    };
    const answer = asOk(await invokeTool(svc, "pipeline_start", { task: "x" }));
    expect(answer).toMatchObject({
      workdir: "/repo/.kodel/worktrees/r_1",
      branch: "kodel/r_1",
      note: "starts from HEAD",
    });
  });

  test("tNN_cwd_must_be_an_absolute_path_of_a_sensible_size", async () => {
    const { svc } = service();
    for (const cwd of ["relative/path", ".", "", "x".repeat(4_097)]) {
      expect(
        await invokeTool(svc, "pipeline_start", { task: "a", cwd }),
        cwd.slice(0, 20),
      ).toMatchObject({
        code: "INVALID_ARGUMENTS",
      });
    }
    for (const cwd of [
      "/a/b",
      "C:\\Users\\me\\repo",
      "C:/Users/me/repo",
      "\\\\server\\share\\repo",
    ]) {
      expect((await invokeTool(svc, "pipeline_start", { task: `ok ${cwd}`, cwd })).ok, cwd).toBe(
        true,
      );
    }
  });

  test("tNN_the_instructions_and_the_start_tool_tell_the_agent_to_work_in_the_workdir", () => {
    expect(SERVER_INSTRUCTIONS).toContain("`workdir`");
    const start = TOOLS.find((t) => t.name === "pipeline_start");
    expect(start?.description).toContain("workdir");
    expect(start?.description).toContain("cwd");
  });
});

describe("the tool surface", () => {
  test("these tools exist, in this order, and the surface is versioned", () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect(TOOLS.map((t) => t.name)).toEqual([
      "pipeline_list",
      "pipeline_resolve",
      "pipeline_plan",
      "pipeline_start",
      "pipeline_next_step",
      "pipeline_report_result",
      "pipeline_complete_step",
      "pipeline_feedback",
    ]);
  });

  test("the instructions the server gives on connecting name only tools that exist", () => {
    const named = [...new Set(SERVER_INSTRUCTIONS.match(/pipeline_[a-z_]+/g) ?? [])];
    expect(named.length).toBeGreaterThan(3);
    const tools = TOOLS.map((t) => t.name);
    for (const name of named) expect(tools, name).toContain(name);
    // and the rules that matter most are there
    for (const rule of ["Never pick, reorder or skip", "cannot approve", ".kodel/runs"]) {
      expect(SERVER_INSTRUCTIONS, rule).toContain(rule);
    }
  });

  test("the arguments of each tool are pinned", () => {
    const shapes = Object.fromEntries(TOOLS.map((t) => [t.name, Object.keys(t.shape)]));
    expect(shapes).toEqual({
      pipeline_list: [],
      pipeline_resolve: ["pipeline"],
      pipeline_plan: ["pipeline", "task"],
      pipeline_start: ["task", "pipeline", "restart", "cwd"],
      pipeline_next_step: ["run_id", "wait_s"],
      pipeline_report_result: [
        "run_id",
        "node_slug",
        "attempt",
        "completeness",
        "incomplete_reason",
        "rows",
        "replace",
        "metrics",
      ],
      pipeline_complete_step: ["run_id", "node_slug", "attempt", "summary", "outcome"],
      pipeline_feedback: ["run_id", "node_slug", "attempt", "category", "message", "suggestion"],
    });
  });

  test("every description tells the agent what to do, and none is empty or vague", () => {
    for (const tool of TOOLS) expect(tool.description.length).toBeGreaterThan(40);
    const text = (name: string) => TOOLS.find((t) => t.name === name)?.description ?? "";
    expect(text("pipeline_complete_step")).toContain("not the verdict");
    expect(text("pipeline_next_step")).toContain("end your turn");
    expect(text("pipeline_start")).toContain("restart");
  });

  test("tools that only read are marked read-only", () => {
    expect(TOOLS.filter((t) => t.readOnly).map((t) => t.name)).toEqual([
      "pipeline_list",
      "pipeline_resolve",
      "pipeline_plan",
      "pipeline_next_step",
    ]);
  });
});

describe("invokeTool", () => {
  test("an unknown tool and bad arguments are INVALID_ARGUMENTS with the place of the problem", async () => {
    const { svc } = service();
    expect(await invokeTool(svc, "pipeline_nope", {})).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENTS",
    });
    const bad = await invokeTool(svc, "pipeline_next_step", {});
    expect(bad).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    if (!bad.ok) expect(bad.message).toContain('"run_id"');
    const worse = await invokeTool(svc, "pipeline_complete_step", {
      run_id: "r",
      node_slug: "plan",
      attempt: 0,
    });
    expect(worse).toMatchObject({ code: "INVALID_ARGUMENTS" });
  });

  test("a run id that is not a run id is refused before it can name a path", async () => {
    const { svc } = service();
    for (const run_id of [
      "../../docs/x",
      "..",
      "r_1",
      "R_000000001_aaaa",
      "r_000000001_aaaa/../x",
    ]) {
      expect(await invokeTool(svc, "pipeline_next_step", { run_id })).toMatchObject({
        ok: false,
        code: "INVALID_ARGUMENTS",
      });
    }
  });

  test("text from the agent has a size limit", async () => {
    const { svc } = service();
    expect(await invokeTool(svc, "pipeline_start", { task: "x".repeat(4_001) })).toMatchObject({
      code: "INVALID_ARGUMENTS",
    });
    const started = await invokeTool(svc, "pipeline_start", { task: "x".repeat(4_000) });
    expect(started.ok).toBe(true);
    const run_id = asOk(started).run_id;
    expect(
      await invokeTool(svc, "pipeline_feedback", {
        run_id,
        category: "other",
        message: "x".repeat(4_001),
      }),
    ).toMatchObject({ code: "INVALID_ARGUMENTS" });
  });

  test("anything the agent adds on its own, like a status or an exit code, is ignored", async () => {
    const { svc, host } = service();
    host.failChecksOnAttempt1 = true;
    const started = await invokeTool(svc, "pipeline_start", { task: "t", status: "passed" });
    expect(started.ok).toBe(true);
    const done = await invokeTool(svc, "pipeline_complete_step", {
      run_id: asOk(started).run_id,
      node_slug: "plan",
      attempt: 1,
      status: "passed",
      exit: 0,
    });
    expect(done).toMatchObject({ ok: true, advanced: false, outcome: "failed" });
  });
});

describe("over a real MCP connection", () => {
  async function connect() {
    const { svc } = service();
    const server = new McpServer({ name: "kodel-test", version: "0.0.0" });
    registerPipelineTools(server, svc);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "agent", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return { client, close: () => Promise.all([client.close(), server.close()]) };
  }

  const text = (result: unknown) =>
    JSON.parse(((result as { content: { text: string }[] }).content[0] as { text: string }).text);

  test("the agent sees all the tools with their descriptions and hints", async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    const next = tools.find((t) => t.name === "pipeline_next_step");
    expect(next?.annotations).toMatchObject({ readOnlyHint: true });
    expect(next?.description).toContain("end your turn");
    expect(next?.inputSchema.required).toEqual(["run_id"]);
    await close();
  });

  test("a whole exchange: start, next step, complete, and a refusal flagged as an error", async () => {
    const { client, close } = await connect();
    const started = await client.callTool({
      name: "pipeline_start",
      arguments: { task: "add a limit" },
    });
    const startBody = text(started);
    expect(startBody).toMatchObject({ ok: true, next: { node: { slug: "plan" } } });
    expect(started.isError).toBe(false);

    const refused = await client.callTool({
      name: "pipeline_complete_step",
      arguments: { run_id: startBody.run_id, node_slug: "plan", attempt: 9 },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatchObject({ ok: false, code: "ATTEMPT_MISMATCH" });

    const done = await client.callTool({
      name: "pipeline_complete_step",
      arguments: { run_id: startBody.run_id, node_slug: "plan", attempt: 1, summary: "done" },
    });
    expect(text(done)).toMatchObject({ ok: true, advanced: true });
    await close();
  });
});
