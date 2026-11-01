import { KodelError } from "../errors";
import type { RecordVersion } from "../version";

const PLACEHOLDER = "<run>";

/** The command that takes a run to the newest format; a person runs it, the agent never does. */
function upgradeCommand(runId?: string): string {
  return `kodel migrate ${runId ?? PLACEHOLDER}`;
}

/**
 * What a run is told when its format cannot hold something it was asked to hold. One place, so the
 * refusal reads the same wherever it comes from (the encoder, the acceptance of a pipeline, the
 * proposal of one) and the way up is named once: offer the person `kodel migrate`, or leave the run
 * with the limits of its format.
 */
export function cannotHoldMessage(version: RecordVersion, what: string, runId?: string): string {
  return `this run is written in run-state format ${version}, which cannot hold ${what}; finish it as it is, or ask the person whether to upgrade it with \`${upgradeCommand(runId)}\` (the upgrade is one way: the older kodel will not read the run afterwards; use the same kodel that started this server; only a person can run it, you must not)`;
}

/** The refusal with the way up in `details`, for the clients that read it from there. */
export function cannotHoldError(version: RecordVersion, what: string, runId?: string): KodelError {
  return new KodelError(
    "UNSUPPORTED_FORMAT_FEATURE",
    cannotHoldMessage(version, what, runId),
    undefined,
    { how_to_upgrade: { cli: upgradeCommand(runId) } },
  );
}

/** The same refusal once the run is known (the encoder of a record does not know it). */
export function withRunId(error: KodelError, runId: string): KodelError {
  if (error.code !== "UNSUPPORTED_FORMAT_FEATURE" || !error.message.includes(PLACEHOLDER)) {
    return error;
  }
  return new KodelError(
    error.code,
    error.message.replace(upgradeCommand(), upgradeCommand(runId)),
    error.issues,
    { how_to_upgrade: { cli: upgradeCommand(runId) } },
  );
}
