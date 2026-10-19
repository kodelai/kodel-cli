/**
 * Runs the real-agent scenarios several times, on one or more models, and says how often each one
 * passes: `bun run test:agents:stats -- --models sonnet,opus --repeat 3`.
 *
 *   --models a,b      models to try (default: $KODEL_AGENT_MODELS, else "sonnet")
 *   --repeat N        how many times each model runs the whole set (default 3)
 *   --files a,b       the test files (default: the three real-agent files)
 *   --min-rate R      exit with 1 if any scenario passes less often than this, 0..1 (default 1)
 *   --allow-skipped   do not fail when a scenario was never run, only skipped
 *   --out DIR         where the JSON of the results goes (default tests/agents/.stats)
 *
 * It uses whatever the local `claude` is logged in with, and a full set takes a few minutes a run.
 * A run in which the test command itself crashes or times out counts as a failure, and so does a
 * scenario that was skipped every time: a nightly job must not come out green because nothing ran.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  aggregate,
  crashed,
  formatTable,
  neverRun,
  parseBunOutput,
  type RunRecord,
  unreliable,
} from "./stats";

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

function usage(message: string): never {
  console.error(`run-stats: ${message}`);
  process.exit(2);
}

const models = option("models", process.env.KODEL_AGENT_MODELS ?? "sonnet")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
if (models.length === 0) usage("no models given");
for (const model of models) {
  // a model is a name, never something a shell or a flag could read as more
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/.test(model)) usage(`"${model}" is not a model name`);
}
const repeat = Number(option("repeat", "3"));
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 50) {
  usage("--repeat is a whole number from 1 to 50");
}
const minRate = Number(option("min-rate", "1"));
if (!Number.isFinite(minRate) || minRate < 0 || minRate > 1)
  usage("--min-rate is a number from 0 to 1");
const allowSkipped = process.argv.includes("--allow-skipped");
const files = option("files", DEFAULT_FILES.join(",")).split(",");
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
    const record =
      results.length === 0
        ? crashed(
            model,
            run,
            `produced no results (${child.error?.message ?? `exit ${child.status ?? child.signal}`})`,
          )
        : { model, run, results };
    records.push(record);
    const failed = record.results.filter((r) => r.verdict === "fail").length;
    console.log(
      `${model} run ${run}/${repeat}: ${record.results.filter((r) => r.verdict === "pass").length} passed, ` +
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

let status = 0;
const below = unreliable(rows).filter((r) => (r.rate ?? 1) < minRate);
if (below.length > 0) {
  console.log(`${below.length} scenario(s) below the minimum rate of ${minRate}`);
  status = 1;
}
const idle = neverRun(rows);
if (idle.length > 0 && !allowSkipped) {
  console.log(
    `${idle.length} scenario(s) were never run, only skipped (use --allow-skipped if so)`,
  );
  status = 1;
}
process.exit(status);
