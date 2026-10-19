/**
 * The conformance suite. Every engine registered here must pass every scenario.
 * There is no engine yet: M2 adds the core engine (in-memory adapters), later the local and the
 * server adapters. Until then the scenarios are listed as todo so the gap stays visible.
 */
import { describe, expect, test } from "bun:test";
import {
  featureScenarios,
  formatReport,
  runScenario,
  type Scenario,
  type ScenarioEngine,
} from "../src";

interface Registered {
  name: string;
  make: () => ScenarioEngine | Promise<ScenarioEngine>;
}

/** Add engines here as they appear. */
const engines: Registered[] = [];

describe("conformance", () => {
  if (engines.length === 0) {
    for (const scenario of featureScenarios) test.todo(`${scenario.id} (no engine registered yet)`);
    return;
  }
  for (const { name, make } of engines) {
    describe(name, () => {
      for (const scenario of featureScenarios as Scenario[]) {
        test(scenario.id, async () => {
          const report = await runScenario(scenario, await make());
          expect(report.ok, formatReport(report)).toBe(true);
        });
      }
    });
  }
});
