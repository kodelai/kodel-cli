/** Format versions, the `format` cascade (pipeline -> config -> 1), readers and migrations. */
import { KodelError } from "./errors";

/** Version stamped as `v` on every machine-written record. */
export const RECORD_VERSION = 1;

/** Used when no `format` is given anywhere: a frozen baseline, not "current". */
export const BASELINE_FORMAT = 1;

/** Highest user-file format this engine can read. */
export const MAX_SUPPORTED_FORMAT = 1;

/**
 * Effective format of a pipeline: the pipeline's own `format`, else the project's, else 1.
 * A format newer than this engine understands is rejected instead of guessed.
 */
export function resolveFormat(pipelineFormat?: number, configFormat?: number): number {
  const format = pipelineFormat ?? configFormat ?? BASELINE_FORMAT;
  if (!Number.isInteger(format) || format < 1) {
    throw new KodelError("PIPELINE_INVALID", `format must be a positive integer, got ${format}`);
  }
  if (format > MAX_SUPPORTED_FORMAT) {
    throw new KodelError(
      "UNSUPPORTED_FORMAT",
      `format ${format} is newer than this engine supports (max ${MAX_SUPPORTED_FORMAT}); upgrade kodel`,
    );
  }
  return format;
}
