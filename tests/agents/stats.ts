/**
 * Turning repeated runs of the real-agent scenarios into numbers: which scenarios pass how often,
 * on which model, and how long they take. A single green run says little about an agent; the rate
 * over several runs says whether a scenario can be relied on.
 */

export type Verdict = "pass" | "fail" | "skip";

export interface TestResult {
  name: string;
  verdict: Verdict;
  ms?: number;
}

export interface RunRecord {
  model: string;
  run: number;
  results: TestResult[];
}

export interface Row {
  name: string;
  model: string;
  runs: number;
  passes: number;
  /** passes over runs that were not skipped, 0..1; `undefined` when every run was skipped. */
  rate: number | undefined;
  /** Mean time of the runs that passed, in seconds. */
  mean_s: number | undefined;
}

const LINE = /^\((pass|fail|skip)\) (.+?)(?: \[([\d.]+)(ms|s)\])?\s*$/;

/** The per-test lines of `bun test` output (it writes them to stderr; pass both streams in). */
export function parseBunOutput(text: string): TestResult[] {
  const results: TestResult[] = [];
  for (const line of text.split("\n")) {
    const match = LINE.exec(line.trimEnd());
    if (!match) continue;
    const [, verdict, name, amount, unit] = match;
    const result: TestResult = { name: String(name), verdict: verdict as Verdict };
    if (amount !== undefined) result.ms = unit === "s" ? Number(amount) * 1000 : Number(amount);
    results.push(result);
  }
  return results;
}

const WEIGHT: Record<Verdict, number> = { skip: 0, pass: 1, fail: 2 };

/** One result per test name in a run: if a name is listed twice (a recap), the worse verdict stands. */
export function dedupe(results: TestResult[]): TestResult[] {
  const byName = new Map<string, TestResult>();
  for (const result of results) {
    const seen = byName.get(result.name);
    if (!seen || WEIGHT[result.verdict] > WEIGHT[seen.verdict]) byName.set(result.name, result);
  }
  return [...byName.values()];
}

export function aggregate(records: RunRecord[]): Row[] {
  const groups = new Map<string, { name: string; model: string; results: TestResult[] }>();
  for (const record of records) {
    for (const result of dedupe(record.results)) {
      const key = `${record.model}\u0000${result.name}`;
      const group = groups.get(key) ?? { name: result.name, model: record.model, results: [] };
      group.results.push(result);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .map(({ name, model, results }): Row => {
      const counted = results.filter((r) => r.verdict !== "skip");
      const passed = counted.filter((r) => r.verdict === "pass");
      const timed = passed.filter((r) => r.ms !== undefined);
      return {
        name,
        model,
        runs: counted.length,
        passes: passed.length,
        rate: counted.length === 0 ? undefined : passed.length / counted.length,
        mean_s:
          timed.length === 0
            ? undefined
            : timed.reduce((sum, r) => sum + (r.ms ?? 0), 0) / timed.length / 1000,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.model.localeCompare(b.model));
}

/** A table for a terminal, the least reliable scenarios first. */
export function formatTable(rows: Row[]): string {
  const ordered = [...rows].sort(
    (a, b) => (a.rate ?? 2) - (b.rate ?? 2) || a.name.localeCompare(b.name),
  );
  const cell = (row: Row) => {
    const rate = row.rate === undefined ? "skipped" : `${row.passes}/${row.runs}`;
    const percent = row.rate === undefined ? "" : ` (${Math.round(row.rate * 100)}%)`;
    const time = row.mean_s === undefined ? "" : `  ${Math.round(row.mean_s)} s`;
    return `${rate}${percent}${time}`;
  };
  const width = Math.max(8, ...ordered.map((r) => r.model.length));
  const lines = ordered.map((r) => `${r.model.padEnd(width)}  ${cell(r).padEnd(18)}  ${r.name}`);
  return `${lines.join("\n")}\n`;
}

/** Scenarios that did not pass every time they were run, over the whole set. */
export function unreliable(rows: Row[]): Row[] {
  return rows.filter((r) => r.rate !== undefined && r.rate < 1);
}

/**
 * Scenarios that were never run, only skipped: a nightly job in which the agent tests were switched
 * off by accident must not come out green, so these are reported apart from the reliable ones.
 */
export function neverRun(rows: Row[]): Row[] {
  return rows.filter((r) => r.runs === 0);
}

/** A run of the test command that left nothing to count (it crashed, or timed out), as a failure. */
export function crashed(model: string, run: number, detail: string): RunRecord {
  return {
    model,
    run,
    results: [{ name: `(the test command itself) ${detail}`, verdict: "fail" }],
  };
}
