/**
 * The shape every stored format (the `v` of `state.json` and of the journal records) has to supply.
 * The engine works on one model (`RunState`); a codec turns what a format stores into that model
 * and back, so a run goes on in the format it started with (AGENTS.md, "Stored data and
 * compatibility"). Pure: no file system, no hashing; the caller hands the bytes in and takes the
 * values out.
 */
import type { JournalRecord, RunState } from "../run";
import type { RecordVersion } from "../version";

/** What a pipeline file can use that a format's own parser reads. */
export type PipelineFeature = "join";

/**
 * What a format can hold and which behaviours it keeps. The engine asks these, never the number.
 * A flag is `false` when the format has no place for the thing, or when the engine of that format
 * did it another way and the run keeps doing it that way.
 */
export interface FormatCapabilities {
  version: RecordVersion;
  /** Forks, joins, more than one pause, a fork attribution on visits and routes. */
  forks: boolean;
  /** A worker's hold on an open agent step (`pipeline_take_step`). */
  claims: boolean;
  /** `Visit.spec`: the pipeline version the work in flight was issued under. */
  visitSpec: boolean;
  /** The declared outcome stays on the node, so a recheck after a failed check ends with it. */
  keepsDeclaredAfterFailedCheck: boolean;
  /** Two edges for one `(from, when)` with no `join` in a snapshot written in this format: the first wins. */
  firstDuplicateEdgeWins: boolean;
  /** The event that names a session of the agent (`agent_session_named`). Format 1 never wrote it. */
  sessionNames: boolean;
  /** The pipeline features a snapshot of this format can use. */
  pipelineFeatures: readonly PipelineFeature[];
}

export interface FormatCodec {
  version: RecordVersion;
  capabilities: FormatCapabilities;
  /** The model from the parsed `state.json`; "cannot read" (`UNSUPPORTED_FORMAT`) when it does not fit. */
  decodeState(raw: unknown): RunState;
  /** The value to store for the model; `UNSUPPORTED_FORMAT_FEATURE` when the format cannot hold it. */
  encodeState(state: RunState): unknown;
  decodeRecord(raw: unknown): JournalRecord;
  encodeRecord(record: JournalRecord): unknown;
}
