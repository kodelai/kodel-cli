/** A `WorkerLauncher` for the TUI tests: no processes, every answer set by the test. */
import { SessionError } from "@kodel-ai/pipeline-core";
import type {
  PreflightInput,
  PreflightResult,
  ResumeInput,
  StartInput,
  WorkerLauncher,
  WorkerProgress,
  WorkerStatus,
} from "../src/worker-launcher";
import { workerNameOf } from "../src/worker-launcher";

export class FakeLauncher implements WorkerLauncher {
  readonly starts: StartInput[] = [];
  readonly resumes: ResumeInput[] = [];
  readonly preflights: PreflightInput[] = [];
  readonly calls: string[] = [];
  readonly statusMap = new Map<string, WorkerStatus>();
  readonly progressMap = new Map<string, WorkerProgress>();
  preflightResult: PreflightResult = { ok: true };
  failStart: Error | undefined;
  failResume: Error | undefined;
  failStatuses: Error | undefined;
  /** Held before `start` or `resume` answers. */
  hold: Promise<void> | undefined;
  /** Held before `statuses` answers; one entry per read, taken in order. */
  holdStatuses: Promise<void>[] = [];
  /** Held before `progress` answers. */
  holdProgress: Promise<void> | undefined;
  readonly stopped: string[] = [];
  started = 1_000_000;

  async preflight(input: PreflightInput): Promise<PreflightResult> {
    this.preflights.push(input);
    return this.preflightResult;
  }

  async start(input: StartInput): Promise<{ name: string }> {
    this.calls.push(`start ${input.runId}`);
    this.starts.push(input);
    await this.hold;
    if (this.failStart) throw this.failStart;
    const name = workerNameOf(input.runId);
    this.statusMap.set(input.runId, {
      id: `a_${this.starts.length.toString(36).padStart(9, "0")}_fake`,
      name,
      state: "running",
      label: "running",
      started: this.started,
      sessionId: "7f3b2a9c-1d4e-4f6a-9b8c-0d1e2f3a4b5c",
      resumed: [],
      resumes: 0,
    });
    return { name };
  }

  async resume(input: ResumeInput): Promise<{ name: string }> {
    this.calls.push(`resume ${input.runId} ${input.decision.seq}`);
    this.resumes.push(input);
    const before = this.statusMap.get(input.runId);
    // The adapter's exclusive marker: the name of the decision is taken once.
    if (before?.resumed.includes(input.decision.seq)) {
      throw new SessionError(
        "NAME_TAKEN",
        `a session named ${workerNameOf(input.runId, input.decision.seq)} exists`,
      );
    }
    await this.hold;
    if (this.failResume) throw this.failResume;
    if (this.statusMap.get(input.runId)?.resumed.includes(input.decision.seq)) {
      throw new SessionError(
        "NAME_TAKEN",
        `a session named ${workerNameOf(input.runId, input.decision.seq)} exists`,
      );
    }
    const name = workerNameOf(input.runId, input.decision.seq);
    const resumed = [...(before?.resumed ?? []), input.decision.seq].sort((a, b) => a - b);
    this.statusMap.set(input.runId, {
      id: `a_${(this.starts.length + this.resumes.length).toString(36).padStart(9, "0")}_fake`,
      name,
      state: "running",
      label: "running",
      started: Date.now(),
      sessionId: input.sessionId,
      resumed,
      resumes: resumed.length,
      decisionSeq: input.decision.seq,
    });
    return { name };
  }

  async statuses(runIds: readonly string[]): Promise<Map<string, WorkerStatus>> {
    this.calls.push("statuses");
    const held = this.holdStatuses.shift();
    if (held) await held;
    if (this.failStatuses) throw this.failStatuses;
    const out = new Map<string, WorkerStatus>();
    for (const id of runIds) {
      const status = this.statusMap.get(id);
      if (status) out.set(id, { ...status, resumed: [...status.resumed] });
    }
    return out;
  }

  async progress(runId: string): Promise<WorkerProgress> {
    this.calls.push(`progress ${runId}`);
    await this.holdProgress;
    const found = this.progressMap.get(runId);
    if (!found) throw new Error(`no progress for ${runId}`);
    return { ...found, lines: [...found.lines] };
  }

  async logs(runId: string): Promise<string> {
    return (this.progressMap.get(runId)?.lines ?? []).join("\n");
  }

  async stop(runId: string): Promise<void> {
    this.stopped.push(runId);
    const status = this.statusMap.get(runId);
    if (status) this.statusMap.set(runId, { ...status, state: "killed", label: "stopped" });
  }

  /** The worker of a run exited: at `since`, with this code. */
  exited(runId: string, since: number, exitCode = 0): void {
    const status = this.statusMap.get(runId);
    if (!status) throw new Error(`no worker for ${runId}`);
    this.statusMap.set(runId, {
      ...status,
      state: "exited",
      label: `exited (${exitCode})`,
      exitCode,
      since,
    });
  }
}
