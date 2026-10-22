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
  "STATE_LOCKED",
  "UNKNOWN_OUTCOME",
  "WORKDIR_MISSING",
  "WORKDIR_INVALID",
  "WORKDIR_CREATE_FAILED",
  "CONFIG_INVALID",
  "PIPELINE_CHANGE_REFUSED",
  "UNKNOWN_TOPIC",
  "TASKS_DISABLED",
  "TASK_NOT_FOUND",
  "INVALID_TASK",
  "TASK_UNSUPPORTED",
  "TASK_TRANSITION_REFUSED",
  "TASK_FIELDS_REQUIRED",
  "TASK_RATE_LIMITED",
  "TASK_AUTH_FAILED",
  "TASK_ADAPTER_FAILED",
  "TASK_KEY_UNAVAILABLE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Shape returned to tool callers on failure. `issues` lists what was wrong with the arguments;
 * `details` is the one place for any other data a code carries (`retry_after_s`, `applied`,
 * `missing`, `adapter_code` of the task tools), so a new datum never claims a top-level key.
 */
export interface ToolError {
  ok: false;
  code: ErrorCode;
  message: string;
  issues?: unknown[];
  details?: Record<string, unknown>;
}

export class KodelError extends Error {
  readonly code: ErrorCode;
  readonly issues: unknown[] | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    issues?: unknown[],
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "KodelError";
    this.code = code;
    this.issues = issues;
    this.details = details;
  }

  override toString(): string {
    return `${this.code}: ${this.message}`;
  }

  toToolError(issues: unknown[] | undefined = this.issues): ToolError {
    const error: ToolError = { ok: false, code: this.code, message: this.message };
    if (issues !== undefined) error.issues = issues;
    if (this.details !== undefined) error.details = this.details;
    return error;
  }
}
