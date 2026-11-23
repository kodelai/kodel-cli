/**
 * Whether the links of a task let `kodel serve` start it now (T-45). Pure. A start by hand is not
 * held back by this: the TUI only shows the answer as a warning.
 */
import type { DependencyRef } from "../tasks";
import { blockedBy, dependencyWords } from "./links";

export interface ReadyTask {
  key: string;
  depends_on?: readonly string[];
  dependencies?: readonly DependencyRef[];
  conflicts_with?: readonly string[];
}

export interface ReadyInput {
  task: ReadyTask;
  /** `any` waives the approval of the dependencies, as the rule that took the task waives its own. */
  approval?: "required" | "any";
  /** The open runs that name a task: task key to run id. */
  openRunTasks?: ReadonlyMap<string, string>;
  /** Runs that cannot be read and are not known to have ended: the task of each is not known. */
  unreadableRuns?: readonly string[];
  /** Tasks started earlier in the same cycle; their runs are not in `openRunTasks` yet. */
  startedNow?: readonly string[];
}

export type Readiness =
  | { ok: true }
  | { ok: false; why: "blocked"; by: string[] }
  /** `with` is absent when the run cannot be read: it may be the run of any task. */
  | { ok: false; why: "conflict"; with?: string; run?: string };

export function ready(input: ReadyInput): Readiness {
  const { task } = input;
  const by = blockedBy(task, input.approval ?? "required");
  if (by.length > 0) return { ok: false, why: "blocked", by };
  const conflicts = task.conflicts_with ?? [];
  if (conflicts.length === 0) return { ok: true };
  for (const other of conflicts) {
    const run = input.openRunTasks?.get(other);
    if (run !== undefined) return { ok: false, why: "conflict", with: other, run };
  }
  const started = conflicts.find((other) => input.startedNow?.includes(other) === true);
  if (started !== undefined) return { ok: false, why: "conflict", with: started };
  const unreadable = input.unreadableRuns?.[0];
  if (unreadable !== undefined) return { ok: false, why: "conflict", run: unreadable };
  return { ok: true };
}

/** One line for a task that is held back; keys, run ids and fixed words only, never a title. */
export function readinessWords(task: ReadyTask, verdict: Exclude<Readiness, { ok: true }>): string {
  if (verdict.why === "blocked") {
    const refs = new Map((task.dependencies ?? []).map((ref) => [ref.key, ref] as const));
    const parts = verdict.by.map((key) => `${key} (${dependencyWords(refs.get(key))})`);
    return `${task.key} waits for ${parts.join(", ")}`;
  }
  if (verdict.with === undefined) {
    return `${task.key} has conflicts and run ${verdict.run ?? "?"} cannot be read`;
  }
  return verdict.run === undefined
    ? `${task.key} conflicts with ${verdict.with} (started in this cycle)`
    : `${task.key} conflicts with ${verdict.with} (run ${verdict.run})`;
}
