/**
 * Typed errors with stable string codes. The codes are part of the tool contract (its error
 * codes section): never rename one without a format bump.
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
  "UNKNOWN_RUN",
  "INVALID_ARGUMENTS",
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
  readonly issues: unknown[] | undefined;

  constructor(code: ErrorCode, message: string, issues?: unknown[]) {
    super(message);
    this.name = "KodelError";
    this.code = code;
    this.issues = issues;
  }

  override toString(): string {
    return `${this.code}: ${this.message}`;
  }

  toToolError(issues: unknown[] | undefined = this.issues): ToolError {
    return issues === undefined
      ? { ok: false, code: this.code, message: this.message }
      : { ok: false, code: this.code, message: this.message, issues };
  }
}
