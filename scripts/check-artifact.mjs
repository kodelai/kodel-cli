// Verifies the built CLI artifact under plain Node (not Bun): it must start, report its version,
// print help, and stay within the size budget.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = join(root, "packages/cli/dist/kodel.js");
const pkg = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8"));
const BUDGET_BYTES = 5 * 1024 * 1024;

const fail = (msg) => {
  console.error(`artifact check failed: ${msg}`);
  process.exit(1);
};

const run = (args) => execFileSync(process.execPath, [artifact, ...args], { encoding: "utf8" });

const size = statSync(artifact).size;
if (size > BUDGET_BYTES) fail(`size ${size} exceeds budget ${BUDGET_BYTES}`);

const version = run(["--version"]).trim();
if (version !== pkg.version) fail(`--version printed "${version}", expected "${pkg.version}"`);

if (!run(["--help"]).includes("kodel")) fail("--help output does not mention kodel");

// The documentation the agent reads (`pipeline_docs`) is embedded text: a build that dropped it would
// only show when an agent asks.
const built = readFileSync(artifact, "utf8");
for (const line of [
  "Build the pipeline from what the project already does",
  "A pipeline is one YAML file",
  "Which check for which job",
  "Complete pipelines. Replace the commands",
]) {
  if (!built.includes(line)) fail(`the documentation line "${line}" is not in the artifact`);
}

console.log(`artifact ok under node ${process.version}: ${size} bytes, version ${version}`);
