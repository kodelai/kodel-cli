/**
 * `kodel agent prune` (T-45): removes the finished agents in one go. It never removes a record that runs,
 * one whose process still runs without a holder, one that cannot be read, nor the agent of a run that is
 * open or cannot be read (its record is what a resume after a decision needs). Each record is read again,
 * by its id, right before it is removed, and the adapter's own `remove` refuses a live one. The question
 * says so when a record that goes holds a conversation `kodel agent start --resume` could continue.
 */
import { isTerminalState, SessionError, type SessionListEntry } from "@kodel-ai/pipeline-core";
import type { AgentContext, AgentProject, AgentSessions } from "./agent-commands";
import { resumeProblem, stateLabel } from "./agent-commands";
import { plain } from "./plain";
import { startedOf } from "./worker-launcher-session";

export interface AgentPruneInput {
  ctx: AgentContext;
  sessions: AgentSessions;
  project: AgentProject;
}

/** The run a record belongs to: a worker's (`kw-<run>[-d<seq>]`) or an engine step's (`ke-<run>-…`). */
const RUN_OF = /^k[we]-(r_[0-9a-z]+_[0-9a-z]+)(?:-|$)/;

export const runOfRecord = (name: string | undefined): string | undefined =>
  name === undefined ? undefined : RUN_OF.exec(name)?.[1];

export type RunEnd = "ended" | "open" | "unknown";

/** Why a record stays, or nothing when it may go. `runEnd` is asked only for a record that names a run. */
export function pruneKeeps(
  entry: SessionListEntry,
  input: { now: number; olderThanMs: number; runEnd: (runId: string) => RunEnd },
): string | undefined {
  if (entry.problem !== undefined) return "cannot be read";
  if (!isTerminalState(entry.status.state)) return "runs";
  if (entry.status.childAlive === true) return "its process still runs";
  if (input.olderThanMs > 0) {
    const ended = entry.status.since ?? startedOf(entry.id);
    if (input.now - ended < input.olderThanMs) return "ended too recently";
  }
  const run = runOfRecord(entry.name);
  if (run !== undefined) {
    const end = input.runEnd(run);
    if (end === "open") return `its run ${run} is open`;
    if (end === "unknown") return `its run ${run} cannot be read`;
  }
  return undefined;
}

const DAY_MS = 24 * 3_600_000;

export async function runAgentPrune(
  input: AgentPruneInput,
  flags: { olderThan?: string; dryRun?: boolean },
): Promise<void> {
  const ctx: AgentContext = input.ctx;
  const { sessions, project } = input;
  const days = flags.olderThan === undefined ? 0 : Number(flags.olderThan);
  if (!Number.isFinite(days) || days < 0) {
    ctx.fail("--older-than is a number of days, zero or more");
  }
  const now = (ctx.now ?? Date.now)();
  const listed = await sessions.list();

  // The runs are read once, and only when a record names one. A run that is not found is not known.
  let runs: Map<string, RunEnd> | undefined;
  if (listed.some((entry) => runOfRecord(entry.name) !== undefined)) {
    runs = new Map();
    try {
      for (const summary of await (await project.host()).runSummaries()) {
        const status = summary.state?.status;
        runs.set(
          summary.meta.runId,
          summary.unreadable !== undefined || status === undefined
            ? "unknown"
            : status === "completed" || status === "failed" || status === "canceled"
              ? "ended"
              : "open",
        );
      }
    } catch {
      runs = new Map(); // nothing could be read: every record of a run stays
    }
  }
  const rule = {
    now,
    olderThanMs: days * DAY_MS,
    runEnd: (runId: string): RunEnd => runs?.get(runId) ?? "unknown",
  };
  const goes = listed.filter((entry) => pruneKeeps(entry, rule) === undefined);
  if (goes.length === 0) {
    ctx.out("nothing to remove\n");
    return;
  }
  for (const entry of goes) {
    ctx.out(`${plain(entry.id)}  ${plain(entry.name ?? "-")}  ${plain(stateLabel(entry))}\n`);
  }
  const count = `${goes.length} finished agent${goes.length === 1 ? "" : "s"}`;
  const resumable = goes.filter((entry) => resumeProblem(entry) === undefined);
  if (resumable.length > 0) {
    const refs = resumable.map((entry) => plain(entry.name ?? entry.id)).join(", ");
    ctx.out(
      `kodel agent start --resume could still continue the conversation of ${refs}; not once ${
        resumable.length === 1 ? "its record is" : "their records are"
      } removed\n`,
    );
  }
  if (flags.dryRun) {
    ctx.out(`would remove ${count}; nothing was removed\n`);
    return;
  }
  await ctx.mustConfirm(
    resumable.length === 0
      ? `Remove ${count}?`
      : `Remove ${count} (${resumable.length} with a conversation that could be continued)?`,
  );
  let removed = 0;
  for (const entry of goes) {
    // Read again, this record alone: the list may have stood at the question for a while, and a record can
    // come alive or be removed by somebody else.
    let again: SessionListEntry;
    try {
      again = { ...entry, status: await sessions.status(entry.id) };
    } catch (error) {
      if (!(error instanceof SessionError)) throw error;
      if (error.code !== "NOT_FOUND") {
        ctx.out(`${plain(entry.id)}: kept (${error.code}: ${plain(error.message)})\n`);
      }
      continue;
    }
    const kept = pruneKeeps(again, rule);
    if (kept !== undefined) {
      ctx.out(`${plain(entry.id)}: kept (${plain(kept)})\n`);
      continue;
    }
    try {
      await sessions.remove(entry.id);
      removed += 1;
    } catch (error) {
      if (!(error instanceof SessionError)) throw error;
      ctx.out(`${plain(entry.id)}: kept (${error.code}: ${plain(error.message)})\n`);
    }
  }
  ctx.out(`removed ${removed} of ${goes.length}\n`);
}
