/**
 * Typed errors with stable string codes. The codes are part of the tool contract
 * (docs/contract.md, section 7): never rename one without a format bump.
 */
export const ERROR_CODES = [
  "UNKNOWN_PIPELINE",
  "PIPELINE_AMBIGUOUS",
  "PIPELINE_INVALID",
  "UNKNOWN_NODE",
  "NODE_NOT_RUNNING",
  "ATTEMPT_MISMATCH",
  "MISSING_REQUIRED_RESULT",
  "INCOMPLETE_RESULT",
  "INVALID_RESULT_ROWS",
  "MISSING_REQUIRED_VALUE",
  "RESULT_TOO_LARGE",
  "CHECK_FAILED",
  "STATE_MODIFIED_EXTERNALLY",
  "UNSUPPORTED_FORMAT",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Shape returned to tool callers on failure. */
export interface ToolError {
  ok: false;
  code: ErrorCode;
  message: string;
  issues?: unknown[];
}

export class KodelError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "KodelError";
    this.code = code;
  }

  override toString(): string {
    return `${this.code}: ${this.message}`;
  }

  toToolError(issues?: unknown[]): ToolError {
    return issues === undefined
      ? { ok: false, code: this.code, message: this.message }
      : { ok: false, code: this.code, message: this.message, issues };
  }
}
