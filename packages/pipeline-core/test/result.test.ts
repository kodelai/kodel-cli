import { describe, expect, test } from "bun:test";
import { evaluateResult, RESULT_LIMITS, type ResultReport, validateReport } from "../src";

const params = {
  columns: {
    severity: { enum: ["blocker", "major", "minor"] },
    location: "location",
    description: "text",
  },
  fail_when: { severity: ["blocker", "major"] },
};

const row = (severity: string) => ({ severity, location: "a.ts:1", description: "something" });
const report = (rows: unknown[], over: Record<string, unknown> = {}) => ({
  completeness: "complete",
  rows,
  ...over,
});

function invalid(input: unknown, p: Record<string, unknown> = params) {
  const result = validateReport(input, p);
  if (result.ok) throw new Error("expected the report to be invalid");
  return result;
}

describe("validateReport", () => {
  test("accepts a well-formed report", () => {
    const result = validateReport(report([row("minor")], { metrics: { files: 3 } }), params);
    expect(result.ok).toBe(true);
  });

  test("accepts an empty list of findings", () => {
    expect(validateReport(report([]), params).ok).toBe(true);
  });

  test("rejects a report that is not an object of the right shape", () => {
    expect(invalid("nope").code).toBe("INVALID_RESULT_ROWS");
    expect(invalid({ completeness: "complete" }).code).toBe("INVALID_RESULT_ROWS");
    expect(invalid(report([], { surprise: 1 })).code).toBe("INVALID_RESULT_ROWS");
    expect(invalid(report([], { completeness: "done" })).code).toBe("INVALID_RESULT_ROWS");
  });

  test("not_run and tool_error need a reason; partial too", () => {
    for (const completeness of ["partial", "not_run", "tool_error"]) {
      expect(invalid(report([], { completeness })).code).toBe("MISSING_REQUIRED_VALUE");
      expect(
        validateReport(
          report([], { completeness, incomplete_reason: "tests did not start" }),
          params,
        ).ok,
      ).toBe(true);
    }
  });

  test("rows must carry every declared column and only those", () => {
    expect(invalid(report([{ severity: "minor", location: "a.ts:1" }])).code).toBe(
      "MISSING_REQUIRED_VALUE",
    );
    expect(invalid(report([{ ...row("minor"), extra: 1 }])).message).toContain(
      'unknown column "extra"',
    );
  });

  test("values must match the column types", () => {
    expect(invalid(report([row("catastrophic")])).message).toContain(
      "must be one of blocker, major, minor",
    );
    expect(invalid(report([{ ...row("minor"), description: 5 }])).message).toContain(
      "must be text",
    );
    const typed = { columns: { n: "number", ok: "boolean", at: "date" } };
    expect(validateReport(report([{ n: 3, ok: true, at: "2026-10-19" }]), typed).ok).toBe(true);
    expect(invalid(report([{ n: "3", ok: true, at: "2026-10-19" }]), typed).message).toContain(
      "must be a number",
    );
    expect(invalid(report([{ n: 3, ok: "yes", at: "2026-10-19" }]), typed).message).toContain(
      "true or false",
    );
    expect(invalid(report([{ n: 3, ok: true, at: "someday" }]), typed).message).toContain(
      "must be a date",
    );
    expect(invalid(report([{ n: Number.NaN, ok: true, at: "2026-10-19" }]), typed).code).toBe(
      "INVALID_RESULT_ROWS",
    );
  });

  test("size limits", () => {
    const many = Array.from({ length: RESULT_LIMITS.maxRows + 1 }, () => row("minor"));
    expect(invalid(report(many)).code).toBe("RESULT_TOO_LARGE");
    const metrics = Object.fromEntries(
      Array.from({ length: RESULT_LIMITS.maxMetrics + 1 }, (_, i) => [`m${i}`, i]),
    );
    expect(invalid(report([], { metrics })).code).toBe("RESULT_TOO_LARGE");
    const huge = { ...row("minor"), description: "x".repeat(RESULT_LIMITS.maxRowBytes) };
    expect(invalid(report([huge])).code).toBe("RESULT_TOO_LARGE");
  });
});

describe("evaluateResult", () => {
  const complete = (rows: Record<string, unknown>[]): ResultReport => ({
    completeness: "complete",
    rows,
  });

  test("no report is a failure", () => {
    const verdict = evaluateResult(undefined, params);
    expect(verdict.passed).toBe(false);
    expect(verdict.code).toBe("MISSING_REQUIRED_RESULT");
  });

  test("only a complete report can pass", () => {
    for (const completeness of ["partial", "not_run", "tool_error"] as const) {
      const verdict = evaluateResult({ completeness, incomplete_reason: "why", rows: [] }, {});
      expect(verdict.passed).toBe(false);
      expect(verdict.code).toBe("INCOMPLETE_RESULT");
      expect(verdict.reason).toContain(completeness);
    }
  });

  test("a row that matches fail_when fails the check", () => {
    const verdict = evaluateResult(complete([row("minor"), row("major")]), params);
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("1 blocking finding:");
    expect(verdict.reason).toContain("major");
  });

  test("rows that do not match, or an empty list, pass", () => {
    expect(evaluateResult(complete([row("minor")]), params).passed).toBe(true);
    expect(evaluateResult(complete([]), params).passed).toBe(true);
  });

  test("without fail_when a complete report always passes", () => {
    expect(evaluateResult(complete([row("blocker")]), { columns: params.columns }).passed).toBe(
      true,
    );
  });

  test("a row matches only when every listed column matches", () => {
    const two = { fail_when: { severity: ["major"], flag: [true] } };
    const rows = [
      { severity: "major", flag: false },
      { severity: "minor", flag: true },
    ];
    expect(evaluateResult(complete(rows), two).passed).toBe(true);
    expect(evaluateResult(complete([{ severity: "major", flag: true }]), two).passed).toBe(false);
  });

  test("counts and lists several blocking findings, showing the first few", () => {
    const rows = Array.from({ length: 5 }, () => row("blocker"));
    const verdict = evaluateResult(complete(rows), params);
    expect(verdict.reason).toContain("5 blocking findings:");
    expect(verdict.reason.split("; ")).toHaveLength(3);
  });
});
