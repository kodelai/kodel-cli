/**
 * The result report an agent sends and the `result` check: validation of the report against the
 * declared columns (what `pipeline_report_result` does at once) and the verdict (what the check
 * does when the node completes).
 */
import { z } from "zod";
import type { CheckVerdict } from "./checks";
import type { ErrorCode } from "./errors";

export interface ResultReport {
  completeness: "complete" | "partial" | "not_run" | "tool_error";
  incomplete_reason?: string;
  rows: Record<string, unknown>[];
  metrics?: Record<string, number>;
}

export const RESULT_LIMITS = {
  maxRows: 500,
  maxMetrics: 64,
  maxRowBytes: 8192,
  /** The whole report as stored, so rows added call after call cannot grow without bound. */
  maxReportBytes: 262_144,
} as const;

/**
 * A row may carry an `id` that is not one of the declared columns: sending a row with an `id`
 * already in the report replaces that row instead of adding a second one.
 */
const ROW_ID = "id";
const ROW_ID_MAX = 64;

type ColumnType = string | { enum: string[] };

export interface ReportProblem {
  code: ErrorCode;
  message: string;
}

const reportSchema = z
  .object({
    completeness: z.enum(["complete", "partial", "not_run", "tool_error"]).optional(),
    incomplete_reason: z.string().max(2_000).optional(),
    rows: z.array(z.record(z.unknown())),
    // Metric names are labels, never free text, so no secret can hide in a key.
    metrics: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.number()).optional(),
  })
  .strict();

function cellProblem(column: string, type: ColumnType, value: unknown): string | undefined {
  if (typeof type === "object") {
    return typeof value === "string" && type.enum.includes(value)
      ? undefined
      : `"${column}" must be one of ${type.enum.join(", ")}`;
  }
  switch (type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? undefined
        : `"${column}" must be a number`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `"${column}" must be true or false`;
    case "date":
      return typeof value === "string" && !Number.isNaN(Date.parse(value))
        ? undefined
        : `"${column}" must be a date`;
    default:
      return typeof value === "string" ? undefined : `"${column}" must be text`;
  }
}

/**
 * Validate a report as the agent sent it. A bad report is rejected at once, never stored.
 * `completeness` is required unless the report is not a verdict on anything (the comments a person
 * made at a gate), where it is taken to be complete.
 */
export function validateReport(
  input: unknown,
  params: Record<string, unknown>,
  requireCompleteness = true,
): { ok: true; report: ResultReport } | ({ ok: false } & ReportProblem) {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") ?? "";
    return {
      ok: false,
      code: "INVALID_RESULT_ROWS",
      message: `the report is malformed${where ? ` at ${where}` : ""}: ${first?.message ?? "invalid"}`,
    };
  }
  if (parsed.data.completeness === undefined && requireCompleteness) {
    return {
      ok: false,
      code: "MISSING_REQUIRED_VALUE",
      message: "the report needs a completeness",
    };
  }
  const report = {
    ...parsed.data,
    completeness: parsed.data.completeness ?? "complete",
  } as ResultReport;

  if (report.completeness !== "complete" && !report.incomplete_reason) {
    return {
      ok: false,
      code: "MISSING_REQUIRED_VALUE",
      message: `completeness "${report.completeness}" needs an incomplete_reason`,
    };
  }
  if (report.rows.length > RESULT_LIMITS.maxRows) {
    return {
      ok: false,
      code: "RESULT_TOO_LARGE",
      message: `more than ${RESULT_LIMITS.maxRows} rows`,
    };
  }
  if (Object.keys(report.metrics ?? {}).length > RESULT_LIMITS.maxMetrics) {
    return {
      ok: false,
      code: "RESULT_TOO_LARGE",
      message: `more than ${RESULT_LIMITS.maxMetrics} metrics`,
    };
  }

  const columns = (params.columns ?? {}) as Record<string, ColumnType>;
  for (const [i, row] of report.rows.entries()) {
    if (JSON.stringify(row).length > RESULT_LIMITS.maxRowBytes) {
      return {
        ok: false,
        code: "RESULT_TOO_LARGE",
        message: `row ${i} is larger than ${RESULT_LIMITS.maxRowBytes} bytes`,
      };
    }
    for (const key of Object.keys(row)) {
      if (!Object.hasOwn(columns, key) && key !== ROW_ID) {
        return {
          ok: false,
          code: "INVALID_RESULT_ROWS",
          message: `row ${i} has an unknown column "${key}"`,
        };
      }
    }
    if (!Object.hasOwn(columns, ROW_ID) && Object.hasOwn(row, ROW_ID)) {
      const id = row[ROW_ID];
      if (typeof id !== "string" || id.length === 0 || id.length > ROW_ID_MAX) {
        return {
          ok: false,
          code: "INVALID_RESULT_ROWS",
          message: `row ${i}: "${ROW_ID}" must be text of 1 to ${ROW_ID_MAX} characters`,
        };
      }
    }
    for (const [column, type] of Object.entries(columns)) {
      if (!Object.hasOwn(row, column)) {
        return {
          ok: false,
          code: "MISSING_REQUIRED_VALUE",
          message: `row ${i} is missing "${column}"`,
        };
      }
      const problem = cellProblem(column, type, row[column]);
      if (problem) {
        return { ok: false, code: "INVALID_RESULT_ROWS", message: `row ${i}: ${problem}` };
      }
    }
  }
  return { ok: true, report };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * Put a validated report together with the one stored for this attempt. Rows are added; a row with
 * an `id` already there replaces it, and a row identical to one there is not added twice (so
 * sending a call again after losing the answer changes nothing). `replace` starts the list over.
 * The last call decides `completeness`. The limits are checked on the result, never by cutting.
 */
export function mergeReports(
  stored: ResultReport | undefined,
  incoming: ResultReport,
  replace: boolean,
): { ok: true; report: ResultReport } | ({ ok: false } & ReportProblem) {
  const base = replace || !stored ? undefined : stored;
  const rows = [...(base?.rows ?? [])];
  for (const row of incoming.rows) {
    const id = row[ROW_ID];
    const key = typeof id === "string" ? undefined : stableJson(row);
    const at = rows.findIndex((r) =>
      typeof id === "string" ? r[ROW_ID] === id : stableJson(r) === key,
    );
    if (at >= 0) rows[at] = row;
    else rows.push(row);
  }
  const metrics = { ...base?.metrics, ...incoming.metrics };
  const report: ResultReport = {
    completeness: incoming.completeness,
    ...(incoming.incomplete_reason === undefined
      ? {}
      : { incomplete_reason: incoming.incomplete_reason }),
    rows,
    ...(Object.keys(metrics).length === 0 ? {} : { metrics }),
  };
  if (rows.length > RESULT_LIMITS.maxRows) {
    return {
      ok: false,
      code: "RESULT_TOO_LARGE",
      message: `the report would have ${rows.length} rows; at most ${RESULT_LIMITS.maxRows} are kept (send replace: true to start the list over)`,
    };
  }
  if (Object.keys(metrics).length > RESULT_LIMITS.maxMetrics) {
    return {
      ok: false,
      code: "RESULT_TOO_LARGE",
      message: `more than ${RESULT_LIMITS.maxMetrics} metrics`,
    };
  }
  if (JSON.stringify(report).length > RESULT_LIMITS.maxReportBytes) {
    return {
      ok: false,
      code: "RESULT_TOO_LARGE",
      message: `the report would be larger than ${RESULT_LIMITS.maxReportBytes} bytes (send replace: true to start the list over)`,
    };
  }
  return { ok: true, report };
}

/** Rows as CSV with a header of the given columns: quotes doubled, a cell with a comma or a line break quoted. */
export function rowsToCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const cell = (value: unknown) => {
    const text = typeof value === "string" ? value : String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [
    columns.map(cell).join(","),
    ...rows.map((r) => columns.map((c) => cell(r[c])).join(",")),
  ].join("\n");
}

/** The verdict of the `result` check: a complete report with no row matching `fail_when`. */
export function evaluateResult(
  report: ResultReport | undefined,
  params: Record<string, unknown>,
): CheckVerdict {
  if (!report) {
    return {
      passed: false,
      reason: "no result was reported for this attempt",
      code: "MISSING_REQUIRED_RESULT",
    };
  }
  if (report.completeness !== "complete") {
    return {
      passed: false,
      reason: `the result is ${report.completeness}${report.incomplete_reason ? `: ${report.incomplete_reason}` : ""}`,
      code: "INCOMPLETE_RESULT",
    };
  }
  const failWhen = (params.fail_when ?? {}) as Record<string, unknown[]>;
  const entries = Object.entries(failWhen);
  if (entries.length === 0) return { passed: true, reason: "" };
  const blocking = report.rows.filter((row) =>
    entries.every(([column, values]) => values.includes(row[column])),
  );
  if (blocking.length === 0) return { passed: true, reason: "" };
  const shown = blocking
    .slice(0, 3)
    .map((row) => JSON.stringify(row))
    .join("; ");
  return {
    passed: false,
    reason: `${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}: ${shown}`,
  };
}
