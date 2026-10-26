/**
 * The record of a patch kept in the run folder (`changes/*.patch`). Pure: the core only carries
 * and checks the values the host made, it reads no file.
 */

/** A patch file in the run folder; `bytes` counts what is stored. */
export interface ChangesRef {
  ref: string;
  bytes: number;
  truncated: boolean;
}

const TREE_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** A git object id (sha1 or sha256); anything else must never reach a git command line. */
export function isTreeId(value: unknown): value is string {
  return typeof value === "string" && TREE_ID.test(value);
}

/**
 * The `changes` field of an event, rebuilt from its three known keys, or nothing for a value that is
 * not one. Whatever else a value carries is not journaled (and is not exempt from redaction).
 */
export function changesField(value: unknown): { changes?: ChangesRef } {
  if (!isChangesRef(value)) return {};
  return { changes: { ref: value.ref, bytes: value.bytes, truncated: value.truncated } };
}

const MAX_REF_LENGTH = 200;

/** The shape of a patch reference: inside `changes/`, nothing that climbs out or is absolute. */
export function isChangesRef(value: unknown): value is ChangesRef {
  if (typeof value !== "object" || value === null) return false;
  const { ref, bytes, truncated } = value as Record<string, unknown>;
  return (
    typeof ref === "string" &&
    ref.startsWith("changes/") &&
    ref.length <= MAX_REF_LENGTH &&
    !ref.includes("..") &&
    !ref.includes("\\") &&
    !ref.includes("\0") &&
    typeof bytes === "number" &&
    Number.isInteger(bytes) &&
    bytes >= 0 &&
    typeof truncated === "boolean"
  );
}

/** The longest text of a patch error that is journaled. */
export const MAX_CHANGES_ERROR = 200;
