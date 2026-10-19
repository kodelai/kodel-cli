import type { PipelineSpec } from "@kodel-ai/pipeline-core";
import type { Matcher } from "./matchers";
import { createMatchers } from "./matchers";
import type { Assertion, Scenario } from "./types";

const NODE_MAP_KEYS = new Set(["attempts", "nodeStatus", "nodeOutcome"]);
const NODE_LIST_KEYS = new Set(["trail", "executed", "never"]);

/**
 * Static checks of a scenario against the pipeline it runs on, so a typo in a node name fails
 * loudly instead of silently asserting nothing. Returns one message per problem.
 */
export function validateScenario(
  scenario: Scenario,
  spec: PipelineSpec,
  extraMatchers: Matcher[] = [],
): string[] {
  const problems: string[] = [];
  const nodes = new Map(spec.nodes.map((n) => [n.slug, n]));
  const matchers = createMatchers(extraMatchers);
  const where = `scenario "${scenario.id}"`;

  for (const [i, inject] of scenario.injects.entries()) {
    if (!nodes.has(inject.node))
      problems.push(`${where}: inject #${i} names unknown node "${inject.node}"`);
    if (!Number.isInteger(inject.attempt) || inject.attempt < 1) {
      problems.push(`${where}: inject #${i} has attempt ${inject.attempt}; attempts start at 1`);
    }
  }
  const seen = new Set<string>();
  for (const inject of scenario.injects) {
    const key = `${inject.node}#${inject.attempt}`;
    if (seen.has(key)) problems.push(`${where}: duplicate inject for ${key}`);
    seen.add(key);
  }

  let checks = 0;
  for (const [i, step] of scenario.steps.entries()) {
    if (step.kind === "event") {
      const e = step.event;
      if (e.kind === "humanApprove" || e.kind === "humanReject") {
        const node = nodes.get(e.node);
        if (!node) problems.push(`${where}: step #${i} names unknown node "${e.node}"`);
        else if (node.kind !== "human") {
          problems.push(`${where}: step #${i} decides node "${e.node}" which is not a human node`);
        }
      }
      if (e.kind === "advanceTime" && !(e.ms > 0))
        problems.push(`${where}: step #${i} advances time by ${e.ms} ms`);
    } else if (step.kind === "check") {
      checks += 1;
      for (const a of step.assertions)
        problems.push(...validateAssertion(where, i, a, nodes, matchers));
    }
  }
  if (checks === 0) problems.push(`${where}: no expect() step; a scenario must assert something`);
  if (scenario.agentMode === "manual" && !scenario.steps.some((s) => s.kind === "tool")) {
    problems.push(`${where}: agent("manual") needs tool steps, otherwise nothing ever completes`);
  }
  return problems;
}

function validateAssertion(
  where: string,
  step: number,
  a: Assertion,
  nodes: Map<string, unknown>,
  matchers: Map<string, Matcher>,
): string[] {
  const problems: string[] = [];
  if (!matchers.has(a.key))
    problems.push(`${where}: step #${step} uses unknown matcher "${a.key}"`);
  const unknown = (slug: string) => `${where}: step #${step} ${a.key} names unknown node "${slug}"`;
  if (NODE_MAP_KEYS.has(a.key) && typeof a.expected === "object" && a.expected !== null) {
    for (const slug of Object.keys(a.expected)) if (!nodes.has(slug)) problems.push(unknown(slug));
  }
  if (NODE_LIST_KEYS.has(a.key) && Array.isArray(a.expected)) {
    for (const slug of a.expected)
      if (!nodes.has(String(slug))) problems.push(unknown(String(slug)));
  }
  if (a.key === "waitingGate" && typeof a.expected === "string" && !nodes.has(a.expected)) {
    problems.push(unknown(a.expected));
  }
  return problems;
}
