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

export const RESULT_LIMITS = { maxRows: 500, maxMetrics: 64, maxRowBytes: 8192 } as const;

type ColumnType = string | { enum: string[] };

export interface ReportProblem {
  code: ErrorCode;
  message: string;
}

const reportSchema = z
  .object({
    completeness: z.enum(["complete", "partial", "not_run", "tool_error"]),
    incomplete_reason: z.string().optional(),
    rows: z.array(z.record(z.unknown())),
    metrics: z.record(z.number()).optional(),
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

/** Validate a report as the agent sent it. A bad report is rejected at once, never stored. */
export function validateReport(
  input: unknown,
  params: Record<string, unknown>,
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
  const report = parsed.data as ResultReport;

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
      if (!(key in columns)) {
        return {
          ok: false,
          code: "INVALID_RESULT_ROWS",
          message: `row ${i} has an unknown column "${key}"`,
        };
      }
    }
    for (const [column, type] of Object.entries(columns)) {
      if (!(column in row)) {
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
