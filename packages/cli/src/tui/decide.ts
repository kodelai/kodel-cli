/**
 * What the loop does for a decision made from the screen: the checks of `kodel gate` / `kodel resume`
 * (`../gate-decision.ts`, the very same functions the commands call), the write, and the bookkeeping
 * of the engine work a decision starts in this process, which the screen waits for when it is left.
 *
 * The write turns on `recheck` of the shared module: the question may have stood on the screen for
 * hours, so the run is looked at again just before anything is written.
 */
import {
  commitGateDecision,
  commitResume,
  DecisionRefused,
  type DecisionRun,
  foreignText,
  type PreparedGate,
  type PreparedResume,
  prepareGateDecision,
  prepareResume,
  WORK_WAIT_MS,
} from "../gate-decision";
import { plain } from "../plain";
import type { CheckResult, DecisionOutcome, DecisionRef } from "./session";

/** A decision asked for from the screen: what the model's effect carries. */
export interface DecisionRequest {
  /** Ties the check and the write of one decision together. */
  flow: number;
  ref: DecisionRef;
  decision: "approve" | "reject" | "resume";
  /** The reason typed for a rejection. */
  reason?: string;
}

/** A run as the loop needs it: the checks and the writes, and the wait for the work they start. */
export interface EngineRun extends DecisionRun {
  waitForRest(ms: number, node?: string): Promise<void>;
  settle(parked?: () => number, deadline?: number): Promise<void>;
}

export interface DecisionSource {
  open(runId: string): Promise<EngineRun | undefined>;
}

/** The engine work that decisions made here started, as the screen sees it when it is left. */
export interface WorkHandle {
  /** Whether a decision was made here, so that there may be work to wait for. */
  pending(): boolean;
  /** Waits for the work, up to the limit of the commands. */
  wait(): Promise<void>;
  /** A second request to leave: the writes in flight are given a moment, then the work is stopped. */
  stop(): Promise<void>;
}

export interface DecisionTools {
  check(runId: string, request: DecisionRequest): Promise<CheckResult>;
  decide(runId: string, request: DecisionRequest): Promise<DecisionOutcome>;
  work: WorkHandle;
}

export interface DecisionToolOptions {
  /** How long the screen stays for the work of its decisions when it is left. */
  waitMs?: number;
  /** How long a second request to leave waits for the writes in flight. */
  stopWaitMs?: number;
  /** Stops the commands the host runs and waits for them to be gone. */
  hardStop?: () => Promise<void>;
}

type Prepared =
  | { kind: "gate"; run: EngineRun; prepared: PreparedGate }
  | { kind: "resume"; run: EngineRun; prepared: PreparedResume };

const reasonOf = (error: unknown) => plain(error instanceof Error ? error.message : String(error));

export function createDecisionTools(
  source: DecisionSource,
  options: DecisionToolOptions = {},
): DecisionTools {
  const checked = new Map<number, Prepared>();
  /** Every `(run, node)` a decision was made at: the work after it is waited for at the end. */
  const decided = new Map<string, { run: EngineRun; node: string }>();
  const inflight = new Set<Promise<unknown>>();

  const check = async (runId: string, request: DecisionRequest): Promise<CheckResult> => {
    try {
      const run = await source.open(runId);
      if (!run) return { ok: false, message: `Run ${plain(runId)} is gone.` };
      if (request.decision === "resume") {
        const prepared = await prepareResume(run, { node: request.ref.node, offerIgnore: false });
        checked.set(request.flow, { kind: "resume", run, prepared });
        return { ok: true, questions: [prepared.question] };
      }
      const prepared = await prepareGateDecision(run, {
        decision: request.decision,
        node: request.ref.node,
        offerIgnore: false,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(request.ref.attempt === undefined ? {} : { expectAttempt: request.ref.attempt }),
      });
      checked.set(request.flow, { kind: "gate", run, prepared });
      const [first = "", ...rest] = prepared.questions;
      const lead = prepared.foreign ? `${foreignText(prepared.runId, prepared.foreign)}\n` : "";
      return { ok: true, questions: [`${lead}${first}`, ...rest] };
    } catch (error) {
      if (error instanceof DecisionRefused) {
        return error.code === "needs_reason"
          ? { ok: false, message: error.message, needsReason: true }
          : { ok: false, message: error.message };
      }
      return { ok: false, message: `Could not check: ${reasonOf(error)}` };
    }
  };

  const decide = async (runId: string, request: DecisionRequest): Promise<DecisionOutcome> => {
    const entry = checked.get(request.flow);
    checked.delete(request.flow);
    if (!entry) return { ok: false, message: "Nothing was checked for this decision; look again." };
    // Registered before the write: leaving the screen while it is made must wait for it.
    decided.set(`${runId}\u0000${request.ref.node}`, { run: entry.run, node: request.ref.node });
    const write = (async (): Promise<DecisionOutcome> => {
      try {
        const done =
          entry.kind === "gate"
            ? await commitGateDecision(entry.run, entry.prepared, request.reason, { recheck: true })
            : await commitResume(entry.run, entry.prepared, { recheck: true });
        if (!done.ok)
          return { ok: false, message: `${done.error.code}: ${plain(done.error.message)}` };
        const node = plain(request.ref.node);
        return {
          ok: true,
          message:
            request.decision === "resume"
              ? `Resumed at «${node}».`
              : `${request.decision === "approve" ? "Approved" : "Rejected"} «${node}».`,
        };
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof DecisionRefused ? error.message : `Not written: ${reasonOf(error)}`,
        };
      }
    })();
    inflight.add(write);
    try {
      return await write;
    } finally {
      inflight.delete(write);
    }
  };

  const work: WorkHandle = {
    pending: () => inflight.size > 0 || decided.size > 0,
    async wait() {
      await Promise.allSettled([...inflight]);
      const until = Date.now() + (options.waitMs ?? WORK_WAIT_MS);
      // What the decision led into is in the decided node's branch; a sibling is not waited for.
      for (const { run, node } of decided.values()) await run.waitForRest(until - Date.now(), node);
      for (const run of new Set([...decided.values()].map((d) => d.run))) {
        await run.settle(() => 0, until);
      }
    },
    async stop() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.stopWaitMs ?? 2_000);
      });
      await Promise.race([Promise.allSettled([...inflight]), late]);
      if (timer !== undefined) clearTimeout(timer);
      await options.hardStop?.();
    },
  };

  return { check, decide, work };
}

/**
 * The options of the loop that make a decision possible. On sample data there are none: a decision
 * only moves a sample around, and nothing is written.
 */
export function decisionOptions(
  source: "demo" | "project",
  tools: DecisionTools | undefined,
): {
  checkDecision?: DecisionTools["check"];
  decide?: DecisionTools["decide"];
  work?: WorkHandle;
} {
  if (source === "demo" || !tools) return {};
  return { checkDecision: tools.check, decide: tools.decide, work: tools.work };
}
