/**
 * Run-state format 2, the current one (forks: `pauses[]`, `forks`, a fork attribution on visits).
 * The model is stored as it is. The current format reads nested objects leniently: a field added to
 * it later without a bump must not make an older engine of this format refuse the run (AGENTS.md,
 * rule 5).
 */
import { KodelError } from "../errors";
import type { JournalRecord, RunState } from "../run";
import type { FormatCapabilities, FormatCodec } from "./types";

export const V2_CAPABILITIES: FormatCapabilities = {
  version: 2,
  forks: true,
  claims: true,
  visitSpec: true,
  keepsDeclaredAfterFailedCheck: true,
  firstDuplicateEdgeWins: false,
  pipelineFeatures: ["join"],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function cannotRead(why: string): KodelError {
  return new KodelError(
    "UNSUPPORTED_FORMAT",
    `a state of run-state format 2 cannot be read: ${why}`,
  );
}

export const v2Codec: FormatCodec = {
  version: 2,
  capabilities: V2_CAPABILITIES,
  decodeState(raw) {
    if (!isObject(raw)) throw cannotRead("it is not an object");
    if (raw.v !== 2) throw cannotRead(`its format is ${String(raw.v)}`);
    if (typeof raw.runId !== "string") throw cannotRead("it has no run id");
    if (!isObject(raw.nodes)) throw cannotRead("it has no nodes");
    if (!Array.isArray(raw.active)) throw cannotRead("it has no list of active visits");
    if (!Array.isArray(raw.pauses)) throw cannotRead("it has no list of pauses");
    return raw as unknown as RunState;
  },
  encodeState(state) {
    if (state.v !== 2) {
      throw new KodelError(
        "UNSUPPORTED_FORMAT_FEATURE",
        `a state of format ${state.v} was given to the encoder of format 2`,
      );
    }
    return state;
  },
  decodeRecord(raw) {
    if (!isObject(raw)) throw cannotRead("a journal record is not an object");
    return raw as JournalRecord;
  },
  encodeRecord(record) {
    if (record.v !== 2) {
      throw new KodelError(
        "UNSUPPORTED_FORMAT_FEATURE",
        `a journal record of format ${record.v} was given to the encoder of format 2`,
      );
    }
    return record;
  },
};
