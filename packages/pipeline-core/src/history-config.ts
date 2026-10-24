/**
 * What a run may keep in its history, as the project config says. The effective values are fixed
 * when the run starts and journaled in `run_started.history`; a category that is off writes nothing
 * at all. A run whose `run_started` has no `history` was started before the section existed.
 */
import { minimatch } from "minimatch";

/** Every category of sensitive data the engine can write into a run's history, each with a switch. */
export const HISTORY_CATEGORIES = ["changes", "output", "prompts", "executor", "tool_log"] as const;

export type HistoryCategory = (typeof HISTORY_CATEGORIES)[number];

export interface HistoryConfig {
  /** File patches. Needs a git repository. `exclude`: globs of paths that never get a patch. */
  changes: { enabled: boolean; exclude: string[]; max_kb: number };
  /** Output of commands and checks. */
  output: { enabled: boolean; max_kb: number };
  /** The prompts the agent was given. */
  prompts: { enabled: boolean };
  /** What the executor ran. */
  executor: { enabled: boolean };
  /** The agent's tool calls. */
  tool_log: { enabled: boolean };
}

export const DEFAULT_HISTORY: HistoryConfig = {
  changes: { enabled: true, exclude: [], max_kb: 512 },
  output: { enabled: true, max_kb: 64 },
  prompts: { enabled: true },
  executor: { enabled: true },
  tool_log: { enabled: true },
};

/** A copy of the defaults, so no caller shares or changes the constant. */
export function defaultHistory(): HistoryConfig {
  return {
    changes: { ...DEFAULT_HISTORY.changes, exclude: [] },
    output: { ...DEFAULT_HISTORY.output },
    prompts: { ...DEFAULT_HISTORY.prompts },
    executor: { ...DEFAULT_HISTORY.executor },
    tool_log: { ...DEFAULT_HISTORY.tool_log },
  };
}

export const MAX_GLOB_LENGTH = 1024;

/**
 * Whether `pattern` can be an `exclude` glob. minimatch reads nearly any string (a lone `[` is a
 * literal), so the refusals are the ones that are certainly a mistake: empty, with a NUL, too long,
 * or one it cannot compile (`makeRe` returns `false`, or throws for a huge pattern). A lone `[` is
 * therefore accepted: it matches a path with a bracket in it, which is what minimatch means by it.
 */
export function isValidGlob(pattern: string): boolean {
  if (pattern === "" || pattern.length > MAX_GLOB_LENGTH || pattern.includes("\0")) return false;
  try {
    return minimatch.makeRe(pattern, { dot: true }) !== false;
  } catch {
    return false;
  }
}
