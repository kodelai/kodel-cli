import { loadPipeline } from "./load";
import { createMatchers, type Matcher } from "./matchers";
import type { Scenario, ScenarioEngine, ToolExpectation, ToolResponse } from "./types";
import { validateScenario } from "./validate";

export interface Divergence {
  /** Index in `scenario.steps`, or -1 for a problem before the first step. */
  step: number;
  kind: "setup" | "assertion" | "tool" | "unsupported" | "engine";
  key?: string;
  expected: unknown;
  actual: unknown;
  detail: string;
}

export interface ScenarioReport {
  scenario: string;
  engine: string;
  ok: boolean;
  /** The first place where the engine disagreed with the scenario. */
  divergence?: Divergence;
}

export interface RunOptions {
  /** Custom matchers, available to this run only. */
  matchers?: Matcher[];
  /** Repository root for pipeline files. */
  root?: string;
}

/** True when every key of `expected` is present in `actual` with an equal value (deeply). */
export function isSubset(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== "object" || expected === null) return Object.is(actual, expected);
  if (typeof actual !== "object" || actual === null) return false;
  return Object.entries(expected).every(([k, v]) =>
    isSubset((actual as Record<string, unknown>)[k], v),
  );
}

function withRunId(value: unknown, runId: string): unknown {
  if (value === "$run") return runId;
  if (Array.isArray(value)) return value.map((v) => withRunId(v, runId));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withRunId(v, runId)]));
  }
  return value;
}

function checkTool(expect: ToolExpectation, response: ToolResponse) {
  if ("error" in expect) {
    const got = response.ok ? "ok" : response.code;
    const ok =
      !response.ok && response.code === expect.error && isSubset(response, expect.match ?? {});
    return {
      ok,
      expected: { error: expect.error, ...expect.match },
      actual: response,
      detail: `tool answered ${got}`,
    };
  }
  const ok = response.ok && isSubset(response, expect.match ?? {});
  return { ok, expected: { ok: true, ...expect.match }, actual: response, detail: "tool response" };
}

/** Run one scenario on one engine. Never throws for a mismatch; the report says what diverged. */
export async function runScenario(
  scenario: Scenario,
  engine: ScenarioEngine,
  options: RunOptions = {},
): Promise<ScenarioReport> {
  const report = (divergence?: Divergence): ScenarioReport =>
    divergence === undefined
      ? { scenario: scenario.id, engine: engine.name, ok: true }
      : { scenario: scenario.id, engine: engine.name, ok: false, divergence };

  const spec = loadPipeline(scenario.pipeline, options.root);
  const matchers = createMatchers(options.matchers);
  const problems = validateScenario(scenario, spec, options.matchers);
  if (problems.length > 0) {
    return report({
      step: -1,
      kind: "setup",
      expected: "a valid scenario",
      actual: problems,
      detail: problems.join("; "),
    });
  }

  let runId = "";
  try {
    ({ runId } = await engine.start({
      spec,
      task: scenario.task,
      injects: scenario.injects,
      agentMode: scenario.agentMode,
    }));

    for (const [i, step] of scenario.steps.entries()) {
      if (step.kind === "event") {
        await engine.applyEvent(step.event);
      } else if (step.kind === "tool") {
        if (!engine.callTool) {
          return report({
            step: i,
            kind: "unsupported",
            expected: step.tool,
            actual: "engine has no callTool",
            detail: `engine "${engine.name}" cannot run tool steps`,
          });
        }
        const args = withRunId(step.args, runId) as Record<string, unknown>;
        const response = await engine.callTool(step.tool, args);
        const result = checkTool(step.expect, response);
        if (!result.ok) return report({ step: i, kind: "tool", key: step.tool, ...result });
      } else {
        const state = await engine.readState();
        for (const assertion of step.assertions) {
          const m = matchers.get(assertion.key);
          if (!m) continue; // already rejected by validateScenario
          const result = m.apply(state, assertion.expected);
          if (!result.ok)
            return report({ step: i, kind: "assertion", key: assertion.key, ...result });
        }
      }
    }
    const early = (engine.refusedFollowUps?.() ?? []).filter((r) => !r.afterEnd);
    if (early.length > 0 && scenario.allowRefusedFollowUps !== true) {
      return report({
        step: scenario.steps.length - 1,
        kind: "engine",
        expected: "no follow-up refused while the run goes",
        actual: early,
        detail: early.map((r) => `${r.event} refused: ${r.code} ${r.message}`).join("; "),
      });
    }
    return report();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return report({ step: -1, kind: "engine", expected: "no exception", actual: detail, detail });
  } finally {
    await engine.dispose?.();
  }
}

export function formatReport(r: ScenarioReport): string {
  if (r.ok) return `PASS ${r.scenario} on ${r.engine}`;
  const d = r.divergence;
  if (!d) return `FAIL ${r.scenario} on ${r.engine}`;
  const at = d.step >= 0 ? `step ${d.step}` : "setup";
  const key = d.key ? ` ${d.key}` : "";
  return [
    `FAIL ${r.scenario} on ${r.engine}: ${at}${key} (${d.kind})`,
    `  ${d.detail}`,
    `  expected: ${JSON.stringify(d.expected)}`,
    `  actual:   ${JSON.stringify(d.actual)}`,
  ].join("\n");
}

/** Run every scenario on a fresh engine from the factory; one report per scenario. */
export async function runConformance(
  makeEngine: () => ScenarioEngine | Promise<ScenarioEngine>,
  scenarios: Scenario[],
  options: RunOptions = {},
): Promise<ScenarioReport[]> {
  const reports: ScenarioReport[] = [];
  for (const scenario of scenarios) {
    reports.push(await runScenario(scenario, await makeEngine(), options));
  }
  return reports;
}
