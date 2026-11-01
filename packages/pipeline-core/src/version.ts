/**
 * The user-file `version` cascade (pipeline -> project config -> baseline).
 * Not to be confused with `RECORD_VERSION`, the numeric `v` on machine-written records.
 */
import { KodelError } from "./errors";

/**
 * Version stamped as `v` on the run state and the journal records (`engine.record_version` says
 * which one a run was started with). Format 2 brought forks: `pauses[]` instead of `pause`, `forks`,
 * a fork attribution on visits. A state of format 1 is refused with `UNSUPPORTED_FORMAT`, not read:
 * the break was made before the first release (AGENTS.md, "Stored data and compatibility"). The
 * seal, the served answers, proposals and `meta.json` have their own versions.
 */
export const RECORD_VERSION = 2;

/** Used when no `version` is given anywhere: a frozen baseline, not "current". */
export const BASELINE_VERSION = "1.0.0";

/** Highest user-file major version this engine can read. */
export const MAX_SUPPORTED_MAJOR = 1;

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const ACCEPTED = 'a positive integer (1) or a quoted semver string ("1.0.0")';

/**
 * Normalizes a `version` value: a positive integer N means `"N.0.0"`, a string must be semver.
 * Anything else is rejected with the value and the accepted forms.
 */
export function parseVersion(raw: unknown): { version: string; major: number } {
  if (typeof raw === "number") {
    if (Number.isInteger(raw) && raw >= 1) return { version: `${raw}.0.0`, major: raw };
  } else if (typeof raw === "string") {
    const match = SEMVER.exec(raw);
    if (match) return { version: raw, major: Number(match[1]) };
  }
  throw new KodelError(
    "PIPELINE_INVALID",
    `version must be ${ACCEPTED}, got ${JSON.stringify(raw)}`,
  );
}

/**
 * Effective version of a pipeline: the pipeline's own `version`, else the project's, else the baseline.
 * A major newer than this engine understands is rejected instead of guessed.
 */
export function resolveVersion(pipelineVersion?: unknown, configVersion?: unknown): string {
  // `null` is a malformed value, not an absent one, so only `undefined` falls through.
  const { version, major } = parseVersion(
    pipelineVersion !== undefined ? pipelineVersion : (configVersion ?? BASELINE_VERSION),
  );
  if (major > MAX_SUPPORTED_MAJOR) {
    throw new KodelError(
      "UNSUPPORTED_FORMAT",
      `version ${version} is newer than this engine supports (max major ${MAX_SUPPORTED_MAJOR}); upgrade kodel`,
    );
  }
  return version;
}
