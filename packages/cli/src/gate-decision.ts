/**
 * The checks of a decision at a gate or a pause, in one place for `kodel gate`, `kodel resume` and
 * the terminal UI, so they cannot drift apart. Two phases: `prepare*` looks at the run and says what
 * the person must be asked; `commit*` writes the decision. The terminal UI asks its question and
 * writes much later than the command does, so it turns on `recheck`: the commit then looks at the run
 * again and refuses when what was shown is no longer what is true. The command does not.
 *
 * This module is not a security boundary: the entry points decide who may call it (`requireHuman`).
 */
import type { ChangeReport, PendingFound } from "@kodel-ai/local";
import type { Decision, RunState } from "@kodel-ai/pipeline-core";
import { changesFingerprint, gateChangesText, gateCommentsText } from "./decide-text";
import { plain } from "./plain";

/** How long a command (or the UI at quit) stays for the work a decision led into. */
export const WORK_WAIT_MS = 30 * 60_000;

/** A refusal in words for the person. `needs_reason`: the UI answers it by asking for one. */
export class DecisionRefused extends Error {
  constructor(
    message: string,
    readonly code?: "needs_reason",
  ) {
    super(message);
  }
}

/** The part of a run the decisions need; `LocalRun` fits it. */
export interface DecisionRun {
  readonly runId: string;
  foreignRoot?(): Promise<string | undefined>;
  state(): Promise<RunState>;
  pendingChange(state?: RunState): Promise<PendingFound | undefined>;
  changesSinceGate(node: string): Promise<ChangeReport>;
  gateResults(node: string): Promise<{ csv: string; count: number } | undefined>;
  decideHuman(node: string, decision: "approved" | "rejected", reason?: string): Promise<Decision>;
  resume(node?: string): Promise<Decision>;
}

/** The decisions at a gate or a pause go after the pipeline change that is waiting, not before it. */
export async function refuseWhilePending(
  run: DecisionRun,
  ignore: boolean,
  offerIgnore = true,
): Promise<void> {
  if (ignore) return;
  const found = await run.pendingChange().catch(() => undefined);
  if (!found?.info.blocking) return;
  throw new DecisionRefused(
    `a change of the pipeline of run ${run.runId} is waiting for you: look at it and accept it with "${plain(found.info.apply)}", or put the pipeline file back as it was.${offerIgnore ? " To decide here without it: --ignore-pending-change" : ""}`,
  );
}

/** The sentence about a run another checkout made; the command prints it, the UI asks with it. */
export function foreignText(runId: string, root: string): string {
  return `Run ${plain(runId)} was made by the checkout at ${plain(root)}, not this one: you are deciding on its behalf, and the work that follows the decision runs in this checkout.`;
}

export interface GateInput {
  decision: "approve" | "reject";
  /** Which step, when more than one waits; the UI always names it. */
  node?: string;
  reason?: string;
  /** The attempt the person looked at; the command has none. */
  expectAttempt?: number;
  ignorePendingChange?: boolean;
  /** The command names its flag in a refusal; the screen has none to name. */
  offerIgnore?: boolean;
}

export interface PreparedGate {
  runId: string;
  decision: "approve" | "reject";
  node: string;
  attempt: number;
  /** Asked in this order; every answer must be yes before anything is written. */
  questions: string[];
  /** What the person is shown, to be compared at the write. */
  found: ChangeReport;
  comments: { csv: string; count: number } | undefined;
  /** The root of the checkout that made the run, when it is not this one. */
  foreign: string | undefined;
}

export async function prepareGateDecision(
  run: DecisionRun,
  input: GateInput,
): Promise<PreparedGate> {
  await refuseWhilePending(run, input.ignorePendingChange === true, input.offerIgnore !== false);
  const state = await run.state();
  const waiting = state.active.filter((v) => v.phase === "human");
  if (input.node === undefined && waiting.length > 1) {
    throw new DecisionRefused(
      `run ${run.runId} waits for a decision at ${waiting.length} steps: ${waiting
        .map((v) => `"${plain(v.node)}"`)
        .join(", ")}. Say which with --node <slug>`,
    );
  }
  const node = input.node ?? waiting[0]?.node;
  const visit = waiting.find((v) => v.node === node);
  if (!node || !visit) {
    throw new DecisionRefused(
      `run ${run.runId} is not waiting for a decision${input.node ? ` at "${plain(input.node)}"` : ""}`,
    );
  }
  if (input.expectAttempt !== undefined && visit.attempt !== input.expectAttempt) {
    throw new DecisionRefused(
      `"${plain(node)}" is no longer at the attempt you looked at (it was decided or reworked meanwhile); look again`,
    );
  }
  // What the agent did after the run stopped here is not what the checks saw. When that cannot be
  // told (the record is gone, or git fails: something an agent could make happen), it is said so
  // and approving needs one more yes. "Nothing changed" is only ever shown when the engine really
  // compared the files.
  const found = await run.changesSinceGate(node);
  // What the agent recorded as the person's comments goes back with a rejection, so it is shown
  // before the person confirms: the agent's wording, not necessarily theirs.
  const comments = input.decision === "reject" ? await run.gateResults(node) : undefined;
  if (input.decision === "reject" && !input.reason && !comments) {
    throw new DecisionRefused('a rejection needs a reason: --reason "..."', "needs_reason");
  }
  const verb = input.decision === "approve" ? "Approve" : "Reject";
  const questions = [
    [
      gateChangesText(found),
      comments ? gateCommentsText(comments) : undefined,
      `${verb} "${plain(node)}" of run ${plain(run.runId)}?`,
    ]
      .filter((part): part is string => part !== undefined)
      .join("\n"),
  ];
  if (found.kind === "unavailable" && input.decision === "approve") {
    questions.push(
      "Approve although what changed since the run stopped here could not be checked?",
    );
  }
  const foreign = await run.foreignRoot?.().catch(() => undefined);
  return {
    runId: run.runId,
    decision: input.decision,
    node,
    attempt: visit.attempt,
    questions,
    found,
    comments,
    foreign,
  };
}

const isShared = (report: ChangeReport) => report.kind === "changes" && report.note !== undefined;

/**
 * Writes the decision. `recheck` (the UI) first looks at the run again: it refuses unless the step
 * still waits at the attempt that was shown, no change of the pipeline blocks, the comments are the
 * ones that were shown (and a rejection without a typed reason still has some), and the files are not
 * worse than shown. A different set of files is kept only while other branches of a fork were
 * running (the tree is one; T-40), as the dialog does.
 */
export async function commitGateDecision(
  run: DecisionRun,
  prepared: PreparedGate,
  reason: string | undefined,
  options: { recheck?: boolean } = {},
): Promise<Decision> {
  if (options.recheck) await recheckGate(run, prepared, reason);
  return run.decideHuman(
    prepared.node,
    prepared.decision === "approve" ? "approved" : "rejected",
    reason,
  );
}

async function recheckGate(
  run: DecisionRun,
  prepared: PreparedGate,
  reason: string | undefined,
): Promise<void> {
  const state = await run.state();
  const visit = state.active.find((v) => v.node === prepared.node && v.phase === "human");
  if (!visit || visit.attempt !== prepared.attempt) {
    throw new DecisionRefused(
      `"${plain(prepared.node)}" is no longer waiting for this decision (it was decided or reworked meanwhile); look again`,
    );
  }
  await refuseWhilePending(run, false, false);
  if (prepared.decision === "reject") {
    const now = await run.gateResults(prepared.node);
    if (!reason && !now) {
      throw new DecisionRefused(
        "the comments recorded at this step are gone and no reason was given; look again",
      );
    }
    if (now?.csv !== prepared.comments?.csv) {
      throw new DecisionRefused(
        "the comments recorded at this step changed while you were reading; look again",
      );
    }
  }
  const now = await run.changesSinceGate(prepared.node);
  if (prepared.found.kind === "changes" && now.kind !== "changes") {
    throw new DecisionRefused(
      "the files could no longer be listed to compare with what was shown; look again",
    );
  }
  if (prepared.found.kind !== "unavailable" && now.kind === "unavailable") {
    throw new DecisionRefused(
      "what changed since the run stopped here can no longer be checked; look again",
    );
  }
  if (
    !isShared(now) &&
    !isShared(prepared.found) &&
    changesFingerprint(now) !== changesFingerprint(prepared.found)
  ) {
    throw new DecisionRefused("the files changed while you were reading; look again");
  }
}

export interface ResumeInput {
  /** Which paused step, when more than one is paused; the UI always names it. */
  node?: string;
  ignorePendingChange?: boolean;
  offerIgnore?: boolean;
}

export interface PreparedResume {
  runId: string;
  /** Exactly what the person named, for the engine call (the record names the pause either way). */
  argNode: string | undefined;
  /** The paused step. */
  node: string;
  question: string;
}

export async function prepareResume(run: DecisionRun, input: ResumeInput): Promise<PreparedResume> {
  // Resuming continues the run, which only the checkout that made it does: said before asking.
  const owner = await run.foreignRoot?.().catch(() => undefined);
  if (owner !== undefined) {
    throw new DecisionRefused(
      `run ${plain(run.runId)} belongs to the checkout at ${plain(owner)}; it is resumed from there`,
    );
  }
  await refuseWhilePending(run, input.ignorePendingChange === true, input.offerIgnore !== false);
  const state = await run.state();
  if (state.pauses.length === 0 || (state.status !== "running" && state.status !== "paused")) {
    throw new DecisionRefused(`run ${run.runId} is not paused`);
  }
  if (input.node === undefined && state.pauses.length > 1) {
    throw new DecisionRefused(
      `run ${run.runId} is paused at ${state.pauses.length} steps: ${state.pauses
        .map((p) => `"${plain(p.node)}"`)
        .join(", ")}. Say which with --node <slug>`,
    );
  }
  const pause =
    input.node === undefined ? state.pauses[0] : state.pauses.find((p) => p.node === input.node);
  if (!pause) {
    throw new DecisionRefused(`run ${run.runId} is not paused at "${plain(input.node ?? "")}"`);
  }
  return {
    runId: run.runId,
    argNode: input.node,
    node: pause.node,
    question: `Resume run ${run.runId}${state.pauses.length > 1 ? ` at "${plain(pause.node)}"` : ""} with more attempts?`,
  };
}

export async function commitResume(
  run: DecisionRun,
  prepared: PreparedResume,
  options: { recheck?: boolean } = {},
): Promise<Decision> {
  if (options.recheck) {
    const owner = await run.foreignRoot?.().catch(() => undefined);
    if (owner !== undefined) {
      throw new DecisionRefused(
        `run ${plain(run.runId)} belongs to the checkout at ${plain(owner)}; it is resumed from there`,
      );
    }
    await refuseWhilePending(run, false, false);
    const state = await run.state();
    if (state.status !== "running" && state.status !== "paused") {
      throw new DecisionRefused(`run ${run.runId} is not paused any more; look again`);
    }
    if (!state.pauses.some((p) => p.node === prepared.node)) {
      throw new DecisionRefused(
        `run ${run.runId} is no longer paused at "${plain(prepared.node)}"; look again`,
      );
    }
  }
  return run.resume(prepared.argNode);
}
