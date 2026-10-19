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
  type RunState,
  type StartOutcome,
  type StepResult,
  validateReport,
} from "../src";
import { CONTRACT_VERSION, invokeTool, registerPipelineTools, TOOLS } from "../src/mcp";

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
  private count = 0;

  constructor(private readonly specs: PipelineSpec[]) {}

  async list() {
    const pipelines: PipelineInfo[] = this.specs.map((s) => ({
      name: s.name,
      format: s.format,
      ...(s.description === undefined ? {} : { description: s.description }),
    }));
    return { pipelines, problems: [] };
  }

  async resolve(name: string) {
    return this.specs.find((s) => s.name === name);
  }

  async start(input: { pipeline: string; task: string; restart: boolean }): Promise<StartOutcome> {
    const spec = this.specs.find((s) => s.name === input.pipeline) as PipelineSpec;
    const active = [...this.runs.values()].find(
      (r) => r.spec.name === input.pipeline && r.task === input.task,
    );
    const status = active?.state_?.status;
    if (active && (status === "running" || status === "paused")) {
      return { status: "reused", run: active };
    }
    if (active && !input.restart) return { status: "terminal", run: active };
    const run = new FakeRun(this, spec, input.task, `run-${++this.count}`);
    this.runs.set(run.runId, run);
    await run.send({ type: "start", runId: run.runId, task: input.task, specHash: "h" });
    return { status: "started", run };
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

  completeStep(node: string, attempt: number, summary?: string) {
    return this.send({
      type: "agent_completed",
      node,
      attempt,
      ...(summary === undefined ? {} : { summary }),
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

  async waitForRest(): Promise<void> {}
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
  test("list shows each pipeline with its name and format", async () => {
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

  test("the arguments of each tool are pinned", () => {
    const shapes = Object.fromEntries(TOOLS.map((t) => [t.name, Object.keys(t.shape)]));
    expect(shapes).toEqual({
      pipeline_list: [],
      pipeline_resolve: ["pipeline"],
      pipeline_plan: ["pipeline", "task"],
      pipeline_start: ["task", "pipeline", "restart"],
      pipeline_next_step: ["run_id"],
      pipeline_report_result: [
        "run_id",
        "node_slug",
        "attempt",
        "completeness",
        "incomplete_reason",
        "rows",
        "metrics",
      ],
      pipeline_complete_step: ["run_id", "node_slug", "attempt", "summary"],
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
