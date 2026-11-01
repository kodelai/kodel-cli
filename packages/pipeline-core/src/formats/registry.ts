/**
 * The stored formats this engine reads and writes, and the one place that turns the text of a
 * `state.json` into the model. A run is read and written in the format it started with; a new run
 * starts in `CURRENT_RECORD_VERSION`.
 */
import { KodelError } from "../errors";
import type { JournalRecord, RunState } from "../run";
import { RECORD_VERSION, type RecordVersion } from "../version";
import type { FormatCapabilities, FormatCodec } from "./types";
import { v1Codec } from "./v1";
import { v2Codec } from "./v2";

export type { FormatCapabilities, FormatCodec, PipelineFeature } from "./types";

const CODECS: Record<number, FormatCodec> = { 1: v1Codec, 2: v2Codec };

/** The format a new run starts in. */
export const CURRENT_RECORD_VERSION: RecordVersion = RECORD_VERSION;

/** Every format this engine knows, oldest first. */
export const KNOWN_RECORD_VERSIONS: readonly RecordVersion[] = [1, 2];

/** The codec of a format, or `undefined` for a number this engine does not know. */
export function codecFor(version: unknown): FormatCodec | undefined {
  return typeof version === "number" ? CODECS[version] : undefined;
}

export function capabilitiesOf(version: RecordVersion): FormatCapabilities {
  const codec = CODECS[version];
  if (!codec) throw new Error(`no codec for run-state format ${version}`);
  return codec.capabilities;
}

function refuseUnknown(version: unknown, what: string): KodelError {
  if (typeof version === "number" && version > CURRENT_RECORD_VERSION) {
    return new KodelError(
      "UNSUPPORTED_FORMAT",
      `${what} was written by a newer kodel (run-state format ${version}, this kodel reads up to ${CURRENT_RECORD_VERSION}); upgrade kodel`,
    );
  }
  return new KodelError(
    "UNSUPPORTED_FORMAT",
    `${what} is written in run-state format ${String(version)}, which this kodel does not know`,
  );
}

/**
 * The model from the text of a `state.json`. A text that is not a JSON object, or has no format
 * number, was changed outside kodel; a format this engine does not know, or a state that does not fit
 * its format, says so and is never called "modified".
 */
export function readRunState(text: string, runId: string): RunState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KodelError(
      "STATE_MODIFIED_EXTERNALLY",
      `the state of run ${runId} is not valid JSON; it was changed outside kodel`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new KodelError(
      "STATE_MODIFIED_EXTERNALLY",
      `the state of run ${runId} is not a JSON object; it was changed outside kodel`,
    );
  }
  const version = (parsed as { v?: unknown }).v;
  if (typeof version !== "number") {
    throw new KodelError(
      "STATE_MODIFIED_EXTERNALLY",
      `the state of run ${runId} has no run-state format version; it was changed outside kodel`,
    );
  }
  const codec = codecFor(version);
  if (!codec) throw refuseUnknown(version, `run ${runId}`);
  return codec.decodeState(parsed);
}

/** The value to store in `state.json` for a model, in the format of the run. */
export function encodeRunState(state: RunState): unknown {
  const codec = codecFor(state.v);
  if (!codec) throw refuseUnknown(state.v, `run ${state.runId}`);
  return codec.encodeState(state);
}

/**
 * A journal record from the parsed line; each line is read by its own `v`. A line that names no
 * format is read as it is (the journal is history: what is there is shown, and the seal and the
 * hashes are what say it was changed); one that names a format this kodel does not know is refused.
 */
export function decodeJournalRecord(raw: unknown): JournalRecord {
  const isObject = typeof raw === "object" && raw !== null && !Array.isArray(raw);
  const version = isObject ? (raw as { v?: unknown }).v : undefined;
  if (isObject && version === undefined) return raw as JournalRecord;
  const codec = codecFor(version);
  if (!codec) throw refuseUnknown(version, "a journal record");
  return codec.decodeRecord(raw);
}

/** The value to append to the journal for a record, in the format named by its `v`. */
export function encodeJournalRecord(record: JournalRecord): unknown {
  const codec = codecFor(record.v);
  if (!codec) throw refuseUnknown(record.v, "a journal record");
  return codec.encodeRecord(record);
}
