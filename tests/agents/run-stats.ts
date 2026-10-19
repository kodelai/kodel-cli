/**
 * Runs the real-agent scenarios several times, on one or more models, and says how often each one
 * passes: `bun run test:agents:stats -- --models sonnet,opus --repeat 3`.
 *
 *   --models a,b     models to try (default: $KODEL_AGENT_MODELS, else "sonnet")
 *   --repeat N       how many times each model runs the whole set (default 3)
 *   --files a,b      the test files (default: the three real-agent files)
 *   --min-rate R     exit with 1 if any scenario passes less often than this, 0..1 (default 1)
 *   --out DIR        where the JSON of the results goes (default tests/agents/.stats)
 *
 * It uses whatever the local `claude` is logged in with, and a full set takes a few minutes a run.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { aggregate, formatTable, parseBunOutput, type RunRecord, unreliable } from "./stats";

const DEFAULT_FILES = [
  "tests/agents/claude-code.test.ts",
  "tests/agents/claude-code-scenarios.test.ts",
  "tests/agents/dev-pipeline.test.ts",
];

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback;
}

const models = option("models", process.env.KODEL_AGENT_MODELS ?? "sonnet")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const repeat = Math.max(1, Number(option("repeat", "3")));
const files = option("files", DEFAULT_FILES.join(",")).split(",");
const minRate = Number(option("min-rate", "1"));
const outDir = resolve(option("out", join(import.meta.dir, ".stats")));

const records: RunRecord[] = [];
for (const model of models) {
  for (let run = 1; run <= repeat; run++) {
    const started = Date.now();
    const child = spawnSync("bun", ["test", ...files, "--timeout", "900000"], {
      env: { ...process.env, KODEL_AGENT_TESTS: "1", KODEL_AGENT_MODEL: model },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    // bun test writes the per-test lines to stderr
    const results = parseBunOutput(`${child.stdout}\n${child.stderr}`);
    records.push({ model, run, results });
    const failed = results.filter((r) => r.verdict === "fail").length;
    console.log(
      `${model} run ${run}/${repeat}: ${results.filter((r) => r.verdict === "pass").length} passed, ` +
        `${failed} failed, ${Math.round((Date.now() - started) / 1000)} s`,
    );
  }
}

const rows = aggregate(records);
console.log(`\n${formatTable(rows)}`);
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, `${JSON.stringify({ models, repeat, files, records, rows }, null, 2)}\n`);
console.log(`results: ${file}`);

const below = unreliable(rows).filter((r) => (r.rate ?? 1) < minRate);
if (below.length > 0) {
  console.log(`${below.length} scenario(s) below the minimum rate of ${minRate}`);
  process.exit(1);
}
