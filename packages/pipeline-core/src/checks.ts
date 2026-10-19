/**
 * The verdicts of the built-in checks, as pure functions of facts a host gathers: a change set for
 * `diff`, an exit code for `command` (the `result` verdict is in `result.ts`). Hosts run the
 * command or take the snapshot; the rules for what counts as a pass live here, once.
 */
import { minimatch } from "minimatch";
import type { ErrorCode } from "./errors";

/** Changed lines per path since a baseline. Paths with 0 lines are treated as unchanged. */
export type ChangeSet = Record<string, number>;

export interface CheckVerdict {
  passed: boolean;
  /** A sentence the agent or the human can act on. Empty when the check passed. */
  reason: string;
  code?: ErrorCode;
  /** For a check that ran a command: what it exited with, kept in the journal. */
  exit?: number;
}

const pass = (): CheckVerdict => ({ passed: true, reason: "" });
const fail = (reason: string, code?: ErrorCode): CheckVerdict =>
  code === undefined ? { passed: false, reason } : { passed: false, reason, code };

const matches = (path: string, patterns: string[]) =>
  patterns.some((p) => minimatch(path, p, { dot: true }));

const list = (paths: string[]) => paths.slice(0, 5).join(", ") + (paths.length > 5 ? ", ..." : "");

/** The four `diff` modes plus the line limits. Parameters are already rendered. */
export function evaluateDiff(changes: ChangeSet, params: Record<string, unknown>): CheckVerdict {
  const patterns = params.paths as string[];
  const mode = (params.mode as string | undefined) ?? "changed";
  const changed = Object.entries(changes).filter(([, lines]) => lines > 0);
  const inside = changed.filter(([path]) => matches(path, patterns));
  const outside = changed.filter(([path]) => !matches(path, patterns));
  const insideLines = inside.reduce((sum, [, lines]) => sum + lines, 0);
  const outsidePaths = outside.map(([path]) => path);

  if ((mode === "changed" || mode === "changed_only") && inside.length === 0) {
    return fail(`nothing changed in ${list(patterns)}`);
  }
  if ((mode === "changed_only" || mode === "only") && outside.length > 0) {
    return fail(`changes outside ${list(patterns)}: ${list(outsidePaths)}`);
  }
  if (mode === "unchanged" && inside.length > 0) {
    return fail(`changed paths that must stay untouched: ${list(inside.map(([p]) => p))}`);
  }

  const min = params.min_lines as number | undefined;
  const max = params.max_lines as number | undefined;
  if (min !== undefined && insideLines < min) {
    return fail(`${insideLines} changed lines in ${list(patterns)}, at least ${min} required`);
  }
  if (max !== undefined && insideLines > max) {
    return fail(`${insideLines} changed lines in ${list(patterns)}, at most ${max} allowed`);
  }
  return pass();
}

/** The exit code of a command against what the node or check expects (default: 0). */
export function evaluateCommand(exit: number, params: Record<string, unknown>): CheckVerdict {
  const expected = (params.expect as { exit: number } | undefined)?.exit ?? 0;
  return exit === expected ? pass() : fail(`the command exited with ${exit}, expected ${expected}`);
}
