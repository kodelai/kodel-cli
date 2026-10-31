/**
 * The usage of a run as the report shows it: tokens per model and an estimated cost, per attempt of an agent node and
 * for the run. Pure: made from the state and the journal. A cost is an estimate computed with the price table of the
 * time (its `revision`s are listed) and never recomputed; `cost-state` of Claude Code is not here and never a cost.
 */
import type { JournalRecord, RunState } from "./run";
import {
  type CostSummary,
  runTotals,
  summarizeCost,
  type TokenSummary,
  tokensOf,
  USAGE_RECORD_FORMAT,
  type UsageTotals,
} from "./usage-record";

/** Why nothing is shown: the run did not ask for it, or it could not be read. */
export type UsageNotCollected =
  | "not_captured"
  | "disabled"
  | "session_unknown"
  | "log_missing"
  | "refused"
  | "unreadable"
  | "busy"
  | "agent_unsupported";

export interface ModelLine extends TokenSummary {
  /** Dollars over the calls that have a cost; `null` when none has. */
  usd: number | null;
  /** Some calls of this model have no price: `usd` is a part of the cost. */
  partial: boolean;
}

export interface UsageLine {
  tokens: TokenSummary;
  cost: CostSummary;
  models: Record<string, ModelLine>;
  /** The response the agent was writing at the end of the step was counted as it stood: its output may be low. */
  last_open: boolean;
  /** Some of the use of this attempt came later than the pass (the pass ran out of time): not all is here. */
  incomplete: boolean;
  /** Some of it is a subagent's, counted under its parent. */
  subagent: boolean;
  /** The set that tells repeats apart overflowed: a repeat may have been counted twice. */
  dedupe_overflow: boolean;
}

export type UsageReport =
  | { not_collected: true; reason: UsageNotCollected }
  | {
      /** A record this engine does not know how to read (written by a newer one): upgrade. */
      cannot_read: true;
      format: string;
    }
  | {
      /** Always `true`: every cost here is an estimate. */
      estimate: true;
      /** The revisions of the price table the costs were computed with, in order of appearance. */
      revisions: string[];
      /**
       * Everything the sessions of the run used up to the last pass. Use after it (the agent's last turn, a wait at
       * the end) is not recorded, so this is a lower bound; `complete` is whether the log was read to its end.
       */
      total: UsageLine;
      lower_bound: true;
      complete: boolean;
      /** Use outside every attempt: a wait at a gate, a pause. */
      unattributed?: UsageLine;
      attempts: ({ node: string; attempt: number } & UsageLine)[];
      /** Reasons usage could not be recorded in part of the run. */
      failed: string[];
    };

function modelLine(
  usage: UsageTotals["models"][string],
  totals: UsageTotals,
  model: string,
): ModelLine {
  const only: UsageTotals = { models: { [model]: usage }, passes: totals.passes };
  const cost = summarizeCost(only);
  return { ...tokensOf(only), usd: cost.usd, partial: cost.partial };
}

export function usageLine(totals: UsageTotals): UsageLine {
  return {
    tokens: tokensOf(totals),
    cost: summarizeCost(totals),
    models: Object.fromEntries(
      Object.entries(totals.models).map(([model, usage]) => [
        model,
        modelLine(usage, totals, model),
      ]),
    ),
    last_open: totals.last_open === true,
    incomplete: totals.incomplete === true,
    subagent: totals.subagent === true,
    dedupe_overflow: totals.dedupe_overflow === true,
  };
}

const NOT_COLLECTED: readonly string[] = [
  "session_unknown",
  "log_missing",
  "refused",
  "unreadable",
  "busy",
  "agent_unsupported",
];

/** The format of the first usage record in the journal that this engine does not know, if there is one. */
function unknownFormat(journal: readonly JournalRecord[]): string | undefined {
  for (const record of journal) {
    if (record.event !== "usage_recorded") continue;
    const delta = record["delta"] as { v?: unknown } | undefined;
    if (delta?.v !== USAGE_RECORD_FORMAT) return String(delta?.v ?? "unknown");
  }
  return undefined;
}

export function usageReport(state: RunState, journal: readonly JournalRecord[]): UsageReport {
  const unknown = unknownFormat(journal);
  if (unknown !== undefined) return { cannot_read: true, format: unknown };
  const usage = state.usage;
  if (usage === undefined) {
    return {
      not_collected: true,
      reason: state.history?.usage?.enabled === false ? "disabled" : "not_captured",
    };
  }
  const attempts = Object.entries(usage.attempts);
  const hasUse = attempts.length > 0 || Object.keys(usage.unattributed.models).length > 0;
  if (!hasUse) {
    const reason = usage.failed.find((r) => NOT_COLLECTED.includes(r));
    // Nothing yet and nothing wrong: the first step has not ended.
    return { not_collected: true, reason: (reason ?? "not_captured") as UsageNotCollected };
  }
  const behind = Object.values(usage.sessions).some((cursor) => cursor.behind === true);
  const total = runTotals(usage);
  return {
    estimate: true,
    revisions: [...usage.revisions],
    total: usageLine(total),
    lower_bound: true,
    complete: !behind,
    ...(Object.keys(usage.unattributed.models).length > 0
      ? { unattributed: usageLine(usage.unattributed) }
      : {}),
    attempts: attempts.map(([key, totals]) => {
      const cut = key.lastIndexOf(":");
      return {
        node: key.slice(0, cut),
        attempt: Number(key.slice(cut + 1)),
        ...usageLine(totals),
      };
    }),
    failed: [...usage.failed],
  };
}
