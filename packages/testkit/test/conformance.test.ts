/**
 * The conformance suite. Every engine registered here must pass every scenario.
 * The core engine with in-memory adapters is registered; the local and the server adapters join
 * the list when they exist.
 */
import { describe, expect, test } from "bun:test";
import {
  featureScenarios,
  formatReport,
  MemoryEngine,
  runScenario,
  type ScenarioEngine,
} from "../src";

interface Registered {
  name: string;
  make: () => ScenarioEngine | Promise<ScenarioEngine>;
}

/** Add engines here as they appear. */
const engines: Registered[] = [{ name: "core-memory", make: () => new MemoryEngine() }];

describe("conformance", () => {
  for (const { name, make } of engines) {
    describe(name, () => {
      for (const scenario of featureScenarios) {
        test(scenario.id, async () => {
          const report = await runScenario(scenario, await make());
          expect(report.ok, formatReport(report)).toBe(true);
        });
      }
    });
  }
});
