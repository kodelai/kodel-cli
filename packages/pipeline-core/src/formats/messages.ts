import type { RecordVersion } from "../version";

/**
 * What a run is told when its format cannot hold something it was asked to hold. One place, so the
 * refusal reads the same wherever it comes from (the encoder, the acceptance of a pipeline, the
 * proposal of one) and the way up is named once.
 */
export function cannotHoldMessage(version: RecordVersion, what: string): string {
  return `this run is written in run-state format ${version}, which cannot hold ${what}; finish it as it is, or ask the person whether to upgrade it (the upgrade is one way: the older kodel will not read the run afterwards)`;
}
