// Make the golden run of run-state format 2 with steps that ask for a model, worked by two workers of a fork
// (fixtures/formats/v2-model/, T-43), and take it into the repository.
//
//   bun scripts/take-v2-model-fixture.mjs [--keep]
//
// Bun, not Node: the script drives `LocalPipelineHost` of `@kodel-ai/local` (the TypeScript sources `kodel mcp` is built
// from) with the usage count on and the agent's session and its two subagents (the workers) written by
// `ClaudeLogBuilder` of the test kit, so that the hand-in of each worker carries its claim token and finds its own log.
// The script plays the agent that drives the run and the workers. Then `scripts/take-format-fixture.mjs v2-model <run>`
// copies the run and rewrites `hashes.json`.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentLogWriter,
  FileStore,
  LocalPipelineHost,
  UsageWriter,
} from "../packages/local/src/index.ts";
import {
  defaultAgentLog,
  defaultHistory,
  defaultUsage,
} from "../packages/pipeline-core/src/index.ts";
import { ClaudeLogBuilder } from "../packages/testkit/src/index.ts";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("CLAUDE")) delete process.env[key];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "kodel-v2-model-")));
const project = join(scratch, "project");
const claude = join(scratch, "claude");
const state = join(scratch, "state");
await mkdir(join(project, ".kodel", "pipelines"), { recursive: true });
await mkdir(state, { recursive: true });
// the integrity record and the sessions of the host go to the scratch, not to the person's home
process.env.KODEL_STATE_DIR = state;

const SESSION = "77777777-7777-4777-8777-777777777777";
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-4-8";

await writeFile(
  join(project, ".kodel", "pipelines", "fork.yaml"),
  [
    "name: fork",
    "description: a fork whose two steps ask for a model",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: review, kind: agent, prompt: review, model: sonnet }",
    "  - { slug: build, kind: agent, prompt: build, model: opus }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: review }",
    "  - { from: plan, to: build }",
    "  - { from: review, to: merge }",
    "  - { from: build, to: merge }",
    "",
  ].join("\n"),
);
const git = (...args) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
git("init", "-q");
git("config", "user.email", "t@example.com");
git("config", "user.name", "T");
git("commit", "-q", "--allow-empty", "-m", "initial");

const env = { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: SESSION };
const writer = new UsageWriter({
  root: project,
  rules: [],
  env: () => env,
  sleep: async () => undefined,
  stepWaitMs: 0,
});
const store = new FileStore({ root: join(project, ".kodel") });
const agentLog = new AgentLogWriter({ store, root: project, rules: [], env: () => env });
const host = new LocalPipelineHost({
  root: project,
  heartbeatMs: 0,
  environment: env,
  history: {
    ...defaultHistory(),
    // no copy of the log: the copy holds the machine's paths, and the usage count does not need it
    agent_log: { ...defaultAgentLog(), enabled: false },
    usage: { ...defaultUsage(), enabled: true },
    // no record of who ran the steps: it would name the session of the environment, which a fixture does not keep
    executor: { enabled: false },
  },
  usage: writer,
  agentLog,
});

const started = await host.start({ pipeline: "fork", task: "ask for a model", restart: false });
const run = started.run;
const runId = run.runId;
// the run works in a worktree of its own, and the agent's log is kept under the folder of that directory
const workdir = (await run.state()).workdir;
if (typeof workdir !== "string") throw new Error("the run has no workdir");

const main = new ClaudeLogBuilder({ sessionId: SESSION, cwd: workdir });
main
  .user("please run the pipeline")
  .say("msg_0", "starting it", { model: OPUS })
  .call(
    "msg_0",
    { id: "toolu_start", name: "mcp__kodel__pipeline_start", input: { task: "ask for a model" } },
    { input: 100, output: 10, model: OPUS },
  )
  .result("toolu_start", [{ type: "text", text: JSON.stringify({ ok: true, run_id: runId }) }])
  .say("msg_1", "planning", { input: 20, output: 5, model: OPUS });
const mainPath = await main.install(claude);
await run.completeStep("plan", 1, "planned");

const tokens = { review: "token-review", build: "token-build" };
for (const node of ["review", "build"]) await run.takeStep({ node, token: tokens[node] });

async function worker(id, node, model, closing) {
  const child = new ClaudeLogBuilder({
    sessionId: id,
    cwd: workdir,
    start: "2026-10-21T10:00:30.000Z",
  });
  child.user("take your step").call(
    `${id}-w1`,
    {
      id: `${id}-tu1`,
      name: "mcp__kodel__pipeline_complete_step",
      input: { run_id: runId, node_slug: node, attempt: 1 },
    },
    { input: 30, output: 7, model },
  );
  if (closing) child.say(`${id}-c1`, "my report", { input: 5, output: 2, model: closing });
  const path = join(dirname(mainPath), SESSION, "subagents", `${id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, child.text());
}
await worker("agent-review", "review", SONNET, OPUS);
await worker("agent-build", "build", OPUS);
await run.completeStep("review", 1, "reviewed", undefined, undefined, tokens.review);
await run.completeStep("build", 1, "built", undefined, undefined, tokens.build);
await run.completeStep("merge", 1, "merged");

const finished = await run.state();
if (finished.status !== "completed")
  throw new Error(`the run ended ${finished.status}, not completed`);
const dir = join(project, ".kodel", "runs", runId);
execFileSync("node", [join(root, "scripts", "take-format-fixture.mjs"), "v2-model", dir], {
  stdio: "inherit",
});
console.log(`the run ${runId} is in fixtures/formats/v2-model/`);
if (keep) console.log(`kept: ${scratch}`);
else await rm(scratch, { recursive: true, force: true });
