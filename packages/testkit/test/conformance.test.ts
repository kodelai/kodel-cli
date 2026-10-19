/**
 * The conformance suite. Every engine registered here must pass every scenario.
 * The core with in-memory adapters and the local host (real git, file store) are registered; the
 * server's adapters join the list when they exist.
 */
import { describe, expect, test } from "bun:test";
import {
  featureScenarios,
  formatReport,
  LocalScenarioEngine,
  MemoryEngine,
  runScenario,
  type ScenarioEngine,
} from "../src";

interface Registered {
  name: string;
  make: () => ScenarioEngine | Promise<ScenarioEngine>;
}

/** Add engines here as they appear. */
const engines: Registered[] = [
  { name: "core-memory", make: () => new MemoryEngine() },
  { name: "local", make: () => new LocalScenarioEngine() },
];

describe("conformance", () => {
  for (const { name, make } of engines) {
    describe(name, () => {
      for (const scenario of featureScenarios) {
        test(scenario.id, async () => {
          const report = await runScenario(scenario, await make());
          expect(report.ok, formatReport(report)).toBe(true);
        }, 60_000);
      }
    });
  }
});
