/**
 * The local host under test. Everything the engine touches is real: a temporary git repository,
 * the file store, working-tree snapshots, the diff between them. Only two things are scripted:
 * what the agent does to the files, and the exit code of a command (a scenario cannot ask a real
 * build to fail on its second attempt). A crash is real too: the process "dies" and a fresh host
 * picks the run up from the files on disk.
 */
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CommandContext,
  type CommandOptions,
  type CommandResult,
  LocalHost,
  type LocalRun,
} from "@kodel-ai/local";
import { DEFAULT_STALE_MS } from "@kodel-ai/pipeline-core";
import type {
  Production,
  ScenarioEngine,
  ScenarioEvent,
  ScenarioState,
  StartContext,
  ToolResponse,
} from "./types";

export class LocalScenarioEngine implements ScenarioEngine {
  readonly name = "local";

  private dir = "";
  private host!: LocalHost;
  private run!: LocalRun;
  private context!: StartContext;
  private clock = 1_000_000;
  private applied = new Set<string>();
  private hangsUsed = new Set<string>();
  private parked = 0;
  private written = 0;
  private reported = new Set<string>();
  private feedbackCount = 0;

  async start(context: StartContext): Promise<{ runId: string }> {
    this.context = context;
    this.dir = await mkdtemp(join(tmpdir(), "kodel-scenario-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: this.dir, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "scenario@example.com");
    git("config", "user.name", "Scenario");
    git("commit", "-q", "--allow-empty", "-m", "initial");

    this.host = new LocalHost(context.spec, {
      root: this.dir,
      clock: () => this.clock,
      heartbeatMs: 0,
      runCommand: (command, options, ctx) => this.scriptedCommand(command, options, ctx),
    });
    const { run } = await this.host.start(context.task);
    this.run = run;
    await this.drive();
    return { runId: run.runId };
  }

  async applyEvent(event: ScenarioEvent): Promise<void> {
    switch (event.kind) {
      case "humanApprove":
      case "humanReject": {
        const result = await this.run.decideHuman(
          event.node,
          event.kind === "humanApprove" ? "approved" : "rejected",
          event.reason,
        );
        if (!result.ok) throw result.error;
        break;
      }
      case "interrupt": {
        // The process dies: its work stops silently, and a fresh host starts from the files.
        this.run.stop();
        await this.run.settle();
        this.run = this.host.open(this.run.runId);
        this.clock += (this.host.engine.staleMs ?? DEFAULT_STALE_MS) + 1_000;
        await this.run.tick();
        break;
      }
      case "advanceTime": {
        this.clock += event.ms;
        for (const work of this.run.activeWork()) {
          await this.run.apply({ type: "heartbeat", node: work.node, attempt: work.attempt });
        }
        await this.run.tick();
        break;
      }
      case "resume":
      case "cancel": {
        const result = await (event.kind === "resume" ? this.run.resume() : this.run.cancel());
        if (!result.ok) throw result.error;
        break;
      }
    }
    await this.drive();
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<ToolResponse> {
    switch (tool) {
      case "pipeline_complete_step": {
        const slug = String(args.node_slug);
        const result = await this.run.completeStep(
          slug,
          Number(args.attempt),
          typeof args.summary === "string" ? args.summary : undefined,
        );
        if (!result.ok)
          return { ok: false, code: result.error.code, message: result.error.message };
        await this.drive();
        const node = (await this.run.state()).nodes[slug];
        return { ok: true, advanced: node?.status === "passed", outcome: node?.outcome ?? null };
      }
      case "pipeline_feedback": {
        const slug = typeof args.node_slug === "string" ? args.node_slug : undefined;
        const result = await this.run.feedback({
          ...(slug === undefined ? {} : { node: slug }),
          category: String(args.category ?? "other"),
          message: String(args.message ?? ""),
        });
        if (!result.ok)
          return { ok: false, code: result.error.code, message: result.error.message };
        this.feedbackCount += 1;
        return { ok: true, id: `f-${this.feedbackCount}` };
      }
      case "pipeline_next_step":
        return { ok: true, ...(await this.run.nextStep()) };
      default:
        return { ok: false, code: "UNKNOWN_TOOL", message: `unknown tool "${tool}"` };
    }
  }

  async readState(): Promise<ScenarioState> {
    const state = await this.run.state();
    const journal = (await this.host.store.readJournal(this.run.runId)).map((r) => r.event);
    const waiting = state.active.find((v) => v.phase === "human")?.node;
    return {
      runStatus: state.status,
      ...(waiting === undefined ? {} : { waitingGate: waiting }),
      nodes: this.context.spec.nodes.map((node) => {
        const run = state.nodes[node.slug];
        return {
          slug: node.slug,
          status: run?.status ?? "pending",
          outcome: run?.outcome ?? null,
          attempt: run?.attempt ?? 0,
        };
      }),
      trail: [...state.trail],
      journal,
    };
  }

  async dispose(): Promise<void> {
    this.run?.stop();
    await this.run?.settle().catch(() => undefined);
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }

  // ── the world around the run ──────────────────────────────────────────────

  private production(node: string, attempt: number): Production {
    return (
      this.context.injects.find((i) => i.node === node && i.attempt === attempt)?.produce ?? {}
    );
  }

  /** The agent (or a command) changes real files in the repository. */
  private async applyProduction(node: string, attempt: number) {
    const key = `${node}#${attempt}`;
    if (this.applied.has(key)) return;
    this.applied.add(key);
    const production = this.production(node, attempt);
    for (const [path, count] of Object.entries(production.changes ?? {})) {
      await mkdir(dirname(join(this.dir, path)), { recursive: true });
      const text = Array.from({ length: count }, () => `${path} line ${++this.written}\n`).join("");
      await appendFile(join(this.dir, path), text);
    }
    for (const path of production.restore ?? []) await rm(join(this.dir, path), { force: true });
  }

  private async scriptedCommand(
    _command: string,
    options: CommandOptions,
    ctx: CommandContext,
  ): Promise<CommandResult> {
    const production = this.production(ctx.node, ctx.attempt);
    const done = (exit: number): CommandResult => ({
      exit,
      timedOut: false,
      aborted: false,
      tail: exit === 0 ? "" : `scripted failure (exit ${exit})`,
      truncated: false,
      durationMs: 0,
    });

    if (ctx.source === "check") {
      const checks = this.context.spec.nodes.find((n) => n.slug === ctx.node)?.checks ?? [];
      const ordinal = checks
        .slice(0, ctx.checkIndex ?? 0)
        .filter((c) => c.kind === "command").length;
      return done(production.checkExits?.[ordinal] ?? 0);
    }

    await this.applyProduction(ctx.node, ctx.attempt);
    const key = `${ctx.node}#${ctx.attempt}`;
    if (production.hangs && !ctx.restart && !this.hangsUsed.has(key)) {
      this.hangsUsed.add(key);
      this.parked += 1;
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      this.parked -= 1;
      return { ...done(137), aborted: true };
    }
    return done(production.exit ?? 0);
  }

  /** Play the agent: do what the next step says, until the run waits for something else. */
  private async drive() {
    for (let i = 0; i < 300; i++) {
      await this.run.settle(() => this.parked);
      const step = await this.run.nextStep();
      if (!("node" in step)) {
        await this.run.settle(() => this.parked);
        return;
      }
      const { slug, attempt } = step.node;
      await this.applyProduction(slug, attempt);
      const sent = this.production(slug, attempt).result;
      if (sent && !this.reported.has(`${slug}#${attempt}`)) {
        this.reported.add(`${slug}#${attempt}`);
        // A report the engine rejects simply is not there when the check looks for it.
        await this.run.reportResult(slug, attempt, sent);
      }
      if (this.context.agentMode !== "auto") return;
      const result = await this.run.completeStep(slug, attempt);
      if (!result.ok) throw result.error;
    }
    throw new Error("the scenario did not come to rest within 300 agent steps");
  }
}
