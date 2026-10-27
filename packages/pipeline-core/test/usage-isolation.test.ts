/**
 * Usage and cost are display data: they never feed a check, a route or a gate (the refutation of that rule is a
 * change in this file's two tests). One test reads the imports of the code that decides, the other runs the same
 * scripted run with different price tables and a pass that fails, and compares what was decided.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import {
  buildDelta,
  decide,
  defaultHistory,
  defaultPricing,
  defaultUsage,
  type PricingContext,
  parsePipeline,
  type RunEvent,
  type RunState,
  type UsageEvent,
} from "../src";

const src = (name: string) => new URL(`../src/${name}`, import.meta.url).pathname;

/** Every module a file imports from: static imports (type-only too), re-exports and dynamic `import()`. */
async function importsOf(path: string): Promise<string[]> {
  const source = ts.createSourceFile(
    path,
    await readFile(path, "utf8"),
    ts.ScriptTarget.ES2023,
    true,
  );
  const modules: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      modules.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      modules.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      modules.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return modules;
}

/** The modules that hold prices, the cost maths, the records and the report of usage. */
const USAGE_MODULES = /^\.\/(usage|usage-record|usage-report|price-table)(\.json)?$/;

describe("t9jrs usage never feeds a check, a route or a gate", () => {
  test("t9jrs_usage_never_feeds_check_route_or_gate: the code that decides imports no usage module", async () => {
    // The checks, the router (`next-step`), the node handlers, the result check and the pipeline itself.
    const deciding = [
      "checks.ts",
      "next-step.ts",
      "nodes.ts",
      "result.ts",
      "registry.ts",
      "pipeline.ts",
      "executor.ts",
      "service.ts",
    ];
    for (const name of deciding) {
      const found = (await importsOf(src(name))).filter((m) => USAGE_MODULES.test(m));
      expect(found, `${name} imports ${found.join(", ")}`).toEqual([]);
    }
  });

  test("t9jrs_usage_never_feeds_check_route_or_gate: run.ts takes only the accounting of records, and only to keep them", async () => {
    const path = src("run.ts");
    // `run.ts` is the state machine that also routes and judges gates. It may import the record types and the sums
    // (to keep the account) and nothing else about usage: no prices, no cost maths, no report.
    const found = (await importsOf(path)).filter((m) => USAGE_MODULES.test(m));
    expect(found).toEqual(["./usage-record"]);
    // ...and it reads `.usage` of the state only in the methods that keep the account.
    const source = ts.createSourceFile(
      path,
      await readFile(path, "utf8"),
      ts.ScriptTarget.ES2023,
      true,
    );
    const readers = new Set<string>();
    const visit = (node: ts.Node, method: string): void => {
      let here = method;
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) here = node.name.text;
      if (ts.isPropertyAccessExpression(node) && node.name.text === "usage") readers.add(here);
      ts.forEachChild(node, (child) => visit(child, here));
    };
    visit(source, "<top>");
    // `start` switches the section on from the run's frozen config; the other two keep the account.
    const allowed = new Set(["start", "usageRecorded", "usageFailed"]);
    const outside = [...readers].filter((name) => !allowed.has(name));
    expect(outside, `.usage read in ${outside.join(", ")}`).toEqual([]);
    expect(readers.size).toBeGreaterThan(0);
  });
});

// ── the same run with different tables ──────────────────────────────────────

const spec = parsePipeline(
  [
    "name: p",
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    "    prompt: write",
    "  - slug: approve",
    "    kind: human",
    "    prompt: ok?",
    "edges:",
    "  - { from: write, to: approve }",
    "  - { from: approve, to: write, when: rejected }",
    "",
  ].join("\n"),
);

const HEX = "c".repeat(64);
const usageEvent = (n: number): UsageEvent => ({
  v: 1,
  agent: "claude-code",
  agent_version: "2.1.310",
  session_id: "s1",
  seq: n,
  ts: "2026-10-27T10:00:00.000Z",
  kind: "usage",
  model: "claude-sonnet-4-5",
  input: 1000 * n,
  output: 100 * n,
  cache_read: 5000,
  cache_write: 2000,
  cache_write_1h: 500,
  reasoning: 0,
  semantics: "additive",
  message_id: `msg_${n}`,
});

const cheap: PricingContext = defaultPricing();
const dear: PricingContext = defaultPricing({
  "claude-sonnet-4-5": { input: 900, output: 900, cache_read: 900, cache_write: 900 },
});

type Mode = "none" | "cheap" | "dear" | "hostile";

/** What was decided: the step's outcome, what the journal says about the run (without usage), where the run is. */
function trace(mode: Mode): unknown[] {
  const out: unknown[] = [];
  let state: RunState | undefined;
  const send = (event: RunEvent) => {
    const result = decide(spec, state, event, 0);
    if (!result.ok) {
      out.push({ event: event.type, refused: result.error.code });
      return;
    }
    state = result.state;
    const usage = event.type === "usage_recorded" || event.type === "usage_failed";
    if (usage) return;
    out.push({
      event: event.type,
      noop: result.noop === true,
      effects: result.effects.map((effect) => effect.type),
      journal: result.journal.map((r) => r.event),
      status: state.status,
      active: state.active.map((v) => `${v.node}:${v.attempt}:${v.phase}`),
    });
  };
  const history = defaultHistory();
  history.usage = defaultUsage();
  send({ type: "start", runId: "r", task: "t", specHash: "h", history });
  // The pass at the end of each agent step, as the host runs it, before the step is judged.
  const pass = (attempt: number) => {
    if (mode === "none") return;
    if (mode === "hostile") {
      // a pass that fails: a record that does not hold, and a failure reported
      send({
        type: "usage_recorded",
        session: "s1",
        node: "write",
        attempt,
        delta: { nonsense: true } as never,
        cursor: { last_seq: 1, last_key: HEX },
      });
      send({ type: "usage_failed", reason: "unreadable" });
      return;
    }
    send({
      type: "usage_recorded",
      session: "s1",
      node: "write",
      attempt,
      delta: buildDelta([usageEvent(attempt)], mode === "dear" ? dear : cheap),
      cursor: { last_seq: attempt, last_key: HEX },
    });
  };
  pass(1);
  send({ type: "agent_completed", node: "write", attempt: 1 });
  send({ type: "human_decided", node: "approve", decision: "rejected", reason: "again" });
  pass(2);
  send({ type: "agent_completed", node: "write", attempt: 2 });
  send({ type: "human_decided", node: "approve", decision: "approved" });
  return out;
}

describe("t9jrs the same run, different tables", () => {
  test("t9jrs_usage_never_feeds_check_route_or_gate: equal routing and gates with other tables, overrides or a pass that fails", () => {
    const base = trace("none");
    expect(base.length).toBeGreaterThan(4);
    expect(trace("cheap")).toEqual(base);
    expect(trace("dear")).toEqual(base);
    expect(trace("hostile")).toEqual(base);
    // the run went through the gate twice and ended
    expect(JSON.stringify(base)).toContain('"status":"completed"');
  });
});
