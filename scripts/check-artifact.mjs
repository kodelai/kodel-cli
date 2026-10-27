// Verifies the built CLI artifact under plain Node (not Bun): it must start, report its version,
// print help, and stay within the size budget.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
// A build that was never given a version would write `0.0.0` into every run's `engine` record.
if (version === "0.0.0" || pkg.version === "0.0.0")
  fail(`the artifact reports version ${version}: set a real version in packages/cli/package.json`);
if (version !== pkg.version) fail(`--version printed "${version}", expected "${pkg.version}"`);

// The commit comes from scripts/build-cli.mjs; an artifact built another way would record `dev`.
const stamped = /BUILD_COMMIT\s*=\s*"([^"]+)"/.exec(readFileSync(artifact, "utf8"))?.[1];
if (stamped === undefined || stamped === "dev")
  fail("the artifact has no commit stamped in it: build it with `bun run build`");

if (!run(["--help"]).includes("kodel")) fail("--help output does not mention kodel");

// The documentation the agent reads (`pipeline_docs`) is embedded text: a build that dropped it would
// only show when an agent asks.
const built = readFileSync(artifact, "utf8");
for (const line of [
  "Build the pipeline from what the project already does",
  "A pipeline is one YAML file",
  "Which check for which job",
  "Complete pipelines. Replace the commands",
  "A checklist for a pipeline that exists",
]) {
  if (!built.includes(line)) fail(`the documentation line "${line}" is not in the artifact`);
}

// The hook runs on every registered event of an agent, so it is a bundle of its own: small, quiet, always
// exit 0, and quick to start. Its start is compared with a bare `node -e 0` measured in the same run, so a
// slow machine does not fail it; what is limited is what the hook adds.
const hookArtifact = join(root, "packages/cli/dist/kodel-hook.js");
const HOOK_BUDGET_BYTES = 100 * 1024;
const HOOK_BUDGET_OVERHEAD_MS = 35;
const HOOK_RUNS = 15;

const hookSize = statSync(hookArtifact).size;
if (hookSize > HOOK_BUDGET_BYTES)
  fail(`hook bundle size ${hookSize} exceeds budget ${HOOK_BUDGET_BYTES}`);

const project = mkdtempSync(join(tmpdir(), "kodel-artifact-"));
try {
  mkdirSync(join(project, ".kodel"));
  writeFileSync(join(project, ".kodel", "config.yaml"), "version: 1\n");
  const event = (name, over = {}) =>
    JSON.stringify({ hook_event_name: name, session_id: "check-1", cwd: project, ...over });
  const runHook = (input, args = ["claude-code"]) =>
    spawnSync(process.execPath, [hookArtifact, ...args], { input, encoding: "utf8" });

  for (const [label, input, args] of [
    ["empty stdin", "", undefined],
    ["garbage", "\u001b[2J not json", undefined],
    ["an unknown agent", event("SessionStart"), ["emacs"]],
    ["no agent", event("SessionStart"), []],
  ]) {
    const r = runHook(input, args);
    if (r.status !== 0 || r.stdout !== "" || r.stderr !== "") {
      fail(
        `the hook bundle must exit 0 and say nothing on ${label}: exit ${r.status}, ${r.stdout}${r.stderr}`,
      );
    }
  }
  const registered = runHook(event("SessionStart"));
  if (registered.status !== 0 || registered.stdout !== "" || registered.stderr !== "") {
    fail("the hook bundle must record a session start silently");
  }
  const index = join(project, ".kodel", "sessions.jsonl");
  if (
    !existsSync(index) ||
    JSON.parse(readFileSync(index, "utf8").trim()).session_id !== "check-1"
  ) {
    fail("the hook bundle did not record the session in .kodel/sessions.jsonl");
  }

  const timed = (command, args, input) => {
    const t = process.hrtime.bigint();
    spawnSync(command, args, { input, stdio: ["pipe", "ignore", "ignore"] });
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
  const bare = [];
  const hook = [];
  const payload = event("PreToolUse");
  for (let i = 0; i < HOOK_RUNS; i += 1) {
    bare.push(timed(process.execPath, ["-e", "0"], ""));
    hook.push(timed(process.execPath, [hookArtifact, "claude-code"], payload));
  }
  const overhead = median(hook) - median(bare);
  console.log(
    `hook start: ${median(hook).toFixed(1)} ms, bare node ${median(bare).toFixed(1)} ms, adds ${overhead.toFixed(1)} ms (budget ${HOOK_BUDGET_OVERHEAD_MS} ms), ${hookSize} bytes`,
  );
  if (overhead > HOOK_BUDGET_OVERHEAD_MS) {
    fail(
      `the hook adds ${overhead.toFixed(1)} ms to the start of node, above the budget of ${HOOK_BUDGET_OVERHEAD_MS} ms`,
    );
  }
} finally {
  rmSync(project, { recursive: true, force: true });
}

// A pipeline run by the built file on plain Node keeps what its commands printed (TASK-CNZ6): once with
// the default, once with `history.output.enabled: false`.
const sdk = createRequire(join(root, "packages/cli/package.json"));
const sdkPath = (file) =>
  pathToFileURL(
    sdk.resolve(`@modelcontextprotocol/sdk/${file}`, {
      paths: [join(root, "packages/cli"), join(root, "packages/pipeline-core"), root],
    }),
  ).href;
const { Client } = await import(sdkPath("client/index.js"));
const { StdioClientTransport } = await import(sdkPath("client/stdio.js"));

async function runOnce(outputEnabled) {
  const dir = mkdtempSync(join(tmpdir(), "kodel-artifact-run-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [artifact, "--root", dir, "mcp"],
    cwd: dir,
    stderr: "ignore",
  });
  const client = new Client({ name: "check-artifact", version: "0" });
  try {
    mkdirSync(join(dir, ".kodel", "pipelines"), { recursive: true });
    writeFileSync(
      join(dir, ".kodel", "config.yaml"),
      [
        "version: 1",
        "worktree: { mode: off }",
        `history: { changes: { enabled: false }, output: { enabled: ${outputEnabled} } }`,
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, ".kodel", "pipelines", "p.yaml"),
      [
        "name: p",
        "nodes:",
        "  - slug: first",
        "    kind: command",
        `    command: node -e "console.log('printed by first')"`,
        "  - slug: second",
        "    kind: command",
        `    command: node -e "console.log('printed by second')"`,
        "edges:",
        "  - { from: first, to: second }",
        "  - { from: first, to: second, when: failed }",
        "  - { from: second, to: first, when: failed }",
        "",
      ].join("\n"),
    );
    await client.connect(transport);
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse(result.content[0].text);
    };
    const started = await call("pipeline_start", {
      task: "keep the output",
      pipeline: "p",
      cwd: dir,
      title: "keep-output",
    });
    if (!started.run_id) fail(`the run did not start: ${JSON.stringify(started)}`);
    for (let i = 0; i < 40; i += 1) {
      const next = await call("pipeline_next_step", { run_id: started.run_id, wait_s: 1 });
      if (next.done) break;
      if (i === 39) fail(`the run did not finish: ${JSON.stringify(next)}`);
    }
    const artifacts = join(dir, ".kodel", "runs", started.run_id, "artifacts");
    return existsSync(artifacts) ? readdirSync(artifacts).sort() : [];
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

const kept = await runOnce(true);
if (kept.join() !== "first-1-command.txt,second-1-command.txt") {
  fail(`the output of the commands was not kept in artifacts/: ${kept.join() || "(nothing)"}`);
}
const none = await runOnce(false);
if (none.length > 0) fail(`history.output.enabled false still wrote: ${none.join()}`);

console.log(`artifact ok under node ${process.version}: ${size} bytes, version ${version}`);
