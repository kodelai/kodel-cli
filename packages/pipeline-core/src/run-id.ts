/**
 * The shape of a run id: `r_<time in base 36>_<random>`. Every host checks it before an id reaches a
 * path, so an id from an agent can never name a directory outside the run folder.
 */
export const RUN_ID_PATTERN = /^r_[0-9a-z]{9}_[0-9a-z]{4}$/;

export const isRunId = (value: string): boolean => RUN_ID_PATTERN.test(value);
