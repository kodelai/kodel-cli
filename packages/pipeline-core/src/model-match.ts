/**
 * The model a step asked for against the models the agent's logs show it used (T-43). Pure: the host
 * reads the kept pipelines and hands in what each attempt asked for; the models seen are in the usage
 * state of the run. The mark is information for the person: it changes no route, no check and no gate,
 * and says `not_observed` whenever it cannot be sure.
 */
import type { JournalRecord, RunState } from "./run";
import { OTHER_MODEL } from "./usage-record";

/**
 * Whether the model asked for (`requested`) is the model seen (`observed`). Both are lower-cased, the
 * `[...]` suffix of an id is dropped, and both are split at `-` and `:`; the name must have a letter. It
 * matches when its segments are a contiguous run of the id's segments: `sonnet` matches
 * `claude-sonnet-5-5`, `claude-sonnet-5` matches it too (a version prefix is meant) and does not match
 * `claude-sonnet-4-6`. A bare family such as `claude` matches every id of it.
 */
export function modelMatches(requested: string, observed: string): boolean {
  if (observed === OTHER_MODEL) return false;
  const want = segments(requested);
  if (want.length === 0 || !/[a-z]/.test(want.join(""))) return false;
  const have = segments(observed);
  for (let start = 0; start + want.length <= have.length; start += 1) {
    if (want.every((part, i) => have[start + i] === part)) return true;
  }
  return false;
}

const segments = (id: string): string[] =>
  id
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .split(/[-:]/)
    .filter((part) => part !== "");

/** Who the model that matched belonged to, as far as the record says. */
export type ModelBy = "host" | "subagent" | "worker";

/** Why a step's models were not judged. */
export const MODEL_NOT_OBSERVED = [
  /** Usage is off, was not captured, has no record for the attempt, or its record is not clean. */
  "usage_missing",
  /** A model id that did not fit the pattern of an id was among those seen, and none matched. */
  "unknown_id",
  /** The run's format keeps no usage, or the client is not one whose log is read. */
  "unsupported",
  /** The run had workers: the pooled use cannot be told apart by step. */
  "workers_in_run",
  /** A worker did the step and its log was not found. */
  "worker_not_found",
] as const;
export type ModelNotObserved = (typeof MODEL_NOT_OBSERVED)[number];

/** One attempt of a step that asked for a model. */
export interface ModelMark {
  node: string;
  attempt: number;
  /** What the pipeline asked for (`declared`). */
  requested: string;
  /** The models the logs show for the attempt, sorted (`derived`); empty when none was read. */
  seen: string[];
  result: "match" | "mismatch" | "not_observed";
  /** Who matched, when the record says. */
  by?: ModelBy;
  reason?: ModelNotObserved;
}

/** What the report says of the models of a run: a mark per attempt that asked for one. */
export interface ModelMarksReport {
  marks: ModelMark[];
  /** A kept copy of the pipeline could not be read, so some attempts' requests are not known. */
  no_snapshot?: true;
}

export interface ModelMarkInput {
  state: RunState;
  journal: readonly JournalRecord[];
  /** What each attempt asked for, by `node:attempt`: read from the pipeline kept with the run. */
  requested: ReadonlyMap<string, string>;
}

const key = (node: string, attempt: number) => `${node}:${attempt}`;

/** A mark for every attempt that asked for a model, in the order the journal entered them. */
export function modelMarks(input: ModelMarkInput): ModelMark[] {
  const { state, journal, requested } = input;
  const usage = state.usage;
  // The model of the agent's own session at the hand-in of the attempt, as the journal kept it.
  const hostModel = new Map<string, string>();
  // What the hand-in of a step a worker did says its worker's log showed; its presence marks the step a worker's.
  const workerModels = new Map<string, string[]>();
  let hadWorkers = false;
  const order: { node: string; attempt: number }[] = [];
  for (const record of journal) {
    const node = typeof record.node === "string" ? record.node : undefined;
    const attempt = typeof record.attempt === "number" ? record.attempt : undefined;
    if (record.event === "step_claimed") hadWorkers = true;
    if (node === undefined || attempt === undefined) continue;
    if (record.event === "node_entered" && requested.has(key(node, attempt))) {
      if (!order.some((o) => o.node === node && o.attempt === attempt))
        order.push({ node, attempt });
    }
    if (record.event === "agent_completed") {
      const model = (record.executor as { model?: { value?: unknown } } | undefined)?.model?.value;
      if (typeof model === "string") hostModel.set(key(node, attempt), model);
      if (Array.isArray(record.worker_models)) {
        hadWorkers = true;
        workerModels.set(
          key(node, attempt),
          record.worker_models.filter((m): m is string => typeof m === "string"),
        );
      }
    }
  }
  const failed = usage?.failed ?? [];
  const behind = Object.values(usage?.sessions ?? {}).some((cursor) => cursor.behind === true);
  const clean = usage !== undefined && failed.length === 0 && !behind;
  return order.map(({ node, attempt }): ModelMark => {
    const asked = requested.get(key(node, attempt)) as string;
    const seen = Object.keys(usage?.attempts[key(node, attempt)]?.models ?? {}).sort();
    const base = { node, attempt, requested: asked, seen };
    const not = (reason: ModelNotObserved): ModelMark => ({
      ...base,
      result: "not_observed",
      reason,
    });
    if (state.v === 1) return not("unsupported");
    // A step a worker did is judged by its worker's own log, never by the pooled use of the session.
    const worker = workerModels.get(key(node, attempt));
    if (worker !== undefined) {
      const own = { ...base, seen: worker };
      if (worker.length === 0)
        return { ...own, result: "not_observed", reason: "worker_not_found" };
      if (worker.some((model) => modelMatches(asked, model))) {
        return { ...own, result: "match", by: "worker" };
      }
      if (worker.includes(OTHER_MODEL)) {
        return { ...own, result: "not_observed", reason: "unknown_id" };
      }
      return { ...own, result: "mismatch" };
    }
    if (failed.includes("agent_unsupported")) return not("unsupported");
    if (hadWorkers) return not("workers_in_run");
    if (!clean || seen.length === 0) return not("usage_missing");
    const matched = seen.filter((model) => modelMatches(asked, model));
    if (matched.length > 0) {
      const host = hostModel.get(key(node, attempt));
      const by: ModelBy | undefined =
        host === undefined ? undefined : modelMatches(asked, host) ? "host" : "subagent";
      return { ...base, result: "match", ...(by === undefined ? {} : { by }) };
    }
    if (seen.includes(OTHER_MODEL)) return not("unknown_id");
    return { ...base, result: "mismatch" };
  });
}
