/** Format versions, the `format` cascade (pipeline -> config -> 1), readers and migrations. */

/** Version stamped as `v` on every machine-written record. */
export const RECORD_VERSION = 1;

/** Used when no `format` is given anywhere: a frozen baseline, not "current". */
export const BASELINE_FORMAT = 1;

/** Highest user-file format this engine can read. */
export const MAX_SUPPORTED_FORMAT = 1;
