/**
 * A launcher of background workers without processes, for the tests of `kodel serve` (TASK-G8KM,
 * T-43). `start` and `resume` make a record (`kw-<run>`, `kw-<run>-d<seq>`) and, by default, drive the
 * run through the host the way an agent would (complete each agent step) until a `waiting` or `done`
 * answer; then the record is `exited`. Switches make a launch lost, silent, failing, exiting early, or
 * throwing after it made its record. Records can be removed (`kodel agent rm`) and stopped.
 */
import type { ServeLauncherPort } from "@kodel-ai/local";
import { type NextStep, SessionError, type SessionState } from "@kodel-ai/pipeline-core";
import type { RunDecision, ServeWorkerView } from "@kodel-ai/pipeline-core/serve";

/** What a launch does. */
export type ScriptedBehaviour =
  /** Drives the run until it waits for a person or is done, then exits (0). */
  | "drive"
  /** The holder is gone at once: the record is `lost`. */
  | "lost"
  /** Starts and prints nothing: the record stays `running`. */
  | "silent"
  /** Throws before it makes any record. */
  | "failing"
  /** Makes a `running` record, then throws (a launcher that spawned and failed to answer). */
  | "throws_after_record"
  /** Exits (1) without doing anything: outside a wait. */
  | "exit_early";

/** The part of a run the launcher drives; `LocalRun` fits it. */
export interface DrivableRun {
  nextStep(options?: { serve?: { caller?: { name: string; version: string } } }): Promise<NextStep>;
  completeStep(node: string, attempt: number, summary?: string): Promise<unknown>;
  waitForRest?(ms: number): Promise<void>;
}

export interface ScriptedLauncherOptions {
  host: { open(runId: string): Promise<DrivableRun | undefined> };
  now: () => number;
  /** What every launch does unless `next` says otherwise. */
  behaviour?: ScriptedBehaviour;
}

export interface ScriptedRecord {
  id: string;
  name: string;
  runId: string;
  state: SessionState;
  started: number;
  since?: number;
  exitCode?: number;
  sessionId: string;
  decisionSeq?: number;
  lastOutputAt?: number;
  stopped?: boolean;
}

export interface ScriptedCall {
  kind: "preflight" | "start" | "resume" | "statuses";
  runId?: string;
  name?: string;
  workdir?: string;
  decision?: RunDecision;
  runIds?: readonly string[];
}

export class ScriptedLauncher implements ServeLauncherPort {
  readonly records: ScriptedRecord[] = [];
  readonly calls: ScriptedCall[] = [];
  /** Behaviours of the next launches, in order; then `behaviour`. */
  readonly next: ScriptedBehaviour[] = [];
  behaviour: ScriptedBehaviour;
  /** `statuses` throws, as `kodel agent ls` failing does. */
  failStatuses = false;
  preflightResult: { ok: true } | { ok: false; reason: string } = { ok: true };
  private count = 0;

  constructor(private readonly options: ScriptedLauncherOptions) {
    this.behaviour = options.behaviour ?? "drive";
  }

  async preflight(): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.calls.push({ kind: "preflight" });
    return this.preflightResult;
  }

  start(input: { runId: string; workdir: string; title: string }): Promise<{ name: string }> {
    this.calls.push({ kind: "start", runId: input.runId, workdir: input.workdir });
    return this.launch(input.runId, `kw-${input.runId}`, undefined);
  }

  resume(input: {
    runId: string;
    workdir: string;
    sessionId: string;
    decision: RunDecision;
  }): Promise<{ name: string }> {
    this.calls.push({
      kind: "resume",
      runId: input.runId,
      workdir: input.workdir,
      decision: input.decision,
    });
    return this.launch(input.runId, `kw-${input.runId}-d${input.decision.seq}`, input.decision.seq);
  }

  async statuses(runIds: readonly string[]): Promise<Map<string, ServeWorkerView>> {
    this.calls.push({ kind: "statuses", runIds: [...runIds] });
    if (this.failStatuses) throw new Error("kodel agent ls failed");
    const out = new Map<string, ServeWorkerView>();
    for (const runId of runIds) {
      const mine = this.records.filter((r) => r.runId === runId);
      if (mine.length === 0) continue;
      const resumes = mine.filter((r) => r.decisionSeq !== undefined);
      const latest =
        [...resumes].sort((a, b) => (b.decisionSeq ?? 0) - (a.decisionSeq ?? 0))[0] ??
        (mine.find((r) => r.decisionSeq === undefined) as ScriptedRecord);
      out.set(runId, {
        id: latest.id,
        name: latest.name,
        state: latest.state,
        label: latest.state,
        started: latest.started,
        ...(latest.since === undefined ? {} : { since: latest.since }),
        ...(latest.exitCode === undefined ? {} : { exitCode: latest.exitCode }),
        sessionId: latest.sessionId,
        resumed: resumes.map((r) => r.decisionSeq as number),
        resumes: resumes.length,
        ...(latest.decisionSeq === undefined ? {} : { decisionSeq: latest.decisionSeq }),
        ...(latest.lastOutputAt === undefined ? {} : { lastOutputAt: latest.lastOutputAt }),
        ...(latest.stopped === true ? { stopped: true } : {}),
      });
    }
    return out;
  }

  /** The records of a run, oldest first. */
  of(runId: string): ScriptedRecord[] {
    return this.records.filter((r) => r.runId === runId);
  }

  /** `kodel agent rm`: removes the record of that name (every record of the run without one). */
  remove(runId: string, name?: string): void {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i] as ScriptedRecord;
      if (r.runId === runId && (name === undefined || r.name === name)) this.records.splice(i, 1);
    }
  }

  /** `kodel agent stop`: the latest record of the run exits, stopped by a person. */
  stop(runId: string): void {
    const latest = this.of(runId).at(-1);
    if (latest === undefined) return;
    latest.state = "exited";
    latest.since = this.options.now();
    latest.stopped = true;
  }

  /** The holder of the latest record of the run is gone. */
  lose(runId: string): void {
    const latest = this.of(runId).at(-1);
    if (latest === undefined) return;
    latest.state = "lost";
    latest.since = this.options.now();
  }

  /** Drives a `silent` worker on, as if it woke up: until a wait or the end, then exits. */
  async wake(runId: string): Promise<void> {
    const latest = this.of(runId).at(-1);
    if (latest === undefined) return;
    await this.drive(latest);
  }

  private async launch(
    runId: string,
    name: string,
    decisionSeq: number | undefined,
  ): Promise<{ name: string }> {
    const behaviour = this.next.shift() ?? this.behaviour;
    if (behaviour === "failing") throw new Error("the agent could not be started");
    if (this.records.some((r) => r.name === name)) {
      throw new SessionError("NAME_TAKEN", `the name ${name} is taken`);
    }
    this.count += 1;
    const now = this.options.now();
    const record: ScriptedRecord = {
      id: `a_${String(this.count).padStart(9, "0")}_test`,
      name,
      runId,
      state: "running",
      started: now,
      lastOutputAt: now,
      sessionId: `session-${runId}`,
      ...(decisionSeq === undefined ? {} : { decisionSeq }),
    };
    this.records.push(record);
    switch (behaviour) {
      case "lost":
        record.state = "lost";
        record.since = now;
        break;
      case "silent":
        break;
      case "throws_after_record":
        throw new Error("the launcher lost its answer after it started the agent");
      case "exit_early":
        record.state = "exited";
        record.since = now;
        record.exitCode = 1;
        break;
      default:
        await this.drive(record);
    }
    return { name };
  }

  private async drive(record: ScriptedRecord): Promise<void> {
    const run = await this.options.host.open(record.runId);
    if (run === undefined) throw new Error(`there is no run ${record.runId}`);
    for (let i = 0; i < 100; i++) {
      const next = await run.nextStep({
        serve: { caller: { name: "scripted-worker", version: "0.0.0" } },
      });
      record.lastOutputAt = this.options.now();
      if ("node" in next) {
        await run.completeStep(next.node.slug, next.node.attempt, "done by the scripted worker");
        await run.waitForRest?.(10_000);
        continue;
      }
      if ("running" in next) {
        await run.waitForRest?.(10_000);
        continue;
      }
      break;
    }
    record.state = "exited";
    record.since = this.options.now();
    record.exitCode = 0;
  }
}
