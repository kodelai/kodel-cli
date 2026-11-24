// Make the golden runs of run-state format 2 whose journal holds a decision an agent made for the person
// (5M9D, fixtures/formats/v2-manager/), and take them into the repository.
//
//   bun scripts/take-v2-manager-fixture.mjs [--keep]
//
// A decision made through a manager's server is journaled with `decided_via: manager` beside
// `decided_by: agent`, and `kodel serve` reads that key: it resumes the run's worker after such a decision
// and not after one an agent made where the run is worked. The three runs hold both cases as real servers
// wrote them.
//
// The servers are real: `kodel mcp` from the TypeScript sources, started as processes over stdio in a
// scratch git repository whose config turns `decisions.agent` on: one with `--role worker`, one with
// `--role manager` and one with no role, each driven by the MCP client. The script plays the agents (it
// calls the tools; the agent steps have no checks, so there are no files to write). No `CLAUDE*` variable
// and no `KODEL_ENGINE` reach the servers: no record names a session, and the server with no role is the
// person's own. Then `scripts/take-format-fixture.mjs v2-manager <run> ...` copies the runs and writes
// `hashes.json`.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The SDK is a dependency of the CLI package, not of the repository root.
const sdk = createRequire(join(root, "packages/cli/package.json"));
const sdkPath = (file) => pathToFileURL(sdk.resolve(`@modelcontextprotocol/sdk/${file}`)).href;
const { Client } = await import(sdkPath("client/index.js"));
const { StdioClientTransport } = await import(sdkPath("client/stdio.js"));
const main = join(root, "packages", "cli", "src", "main.ts");
const keep = process.argv.includes("--keep");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "kodel-v2-manager-")));
const project = join(scratch, "project");
await mkdir(join(project, ".kodel", "pipelines"), { recursive: true });
await mkdir(join(scratch, "home"), { recursive: true });

const gated = (shipPrompt) =>
  [
    "name: gated",
    "description: a step, a gate for the person, and a last step",
    "nodes:",
    "  - { slug: write, kind: agent, prompt: write it }",
    "  - { slug: approve, kind: human, prompt: Looks fine? }",
    `  - { slug: ship, kind: agent, prompt: ${shipPrompt} }`,
    "edges:",
    "  - { from: write, to: approve }",
    "  - { from: approve, to: ship }",
    "  - { from: approve, to: write, when: rejected }",
    "",
  ].join("\n");
const two = (shipPrompt) =>
  [
    "name: two",
    "description: two steps",
    "nodes:",
    "  - { slug: write, kind: agent, prompt: write it }",
    `  - { slug: ship, kind: agent, prompt: ${shipPrompt} }`,
    "edges:",
    "  - { from: write, to: ship }",
    "",
  ].join("\n");
await writeFile(join(project, ".kodel", "pipelines", "gated.yaml"), gated("ship it"));
await writeFile(join(project, ".kodel", "pipelines", "two.yaml"), two("ship it"));
await writeFile(
  join(project, ".kodel", "config.yaml"),
  // No copy of the agent's log (no agent ran), no usage count and no tool-call rows for the same reason.
  [
    "decisions:",
    "  agent:",
    "    gate: true",
    "    pipeline_change: true",
    "history:",
    "  agent_log: { enabled: false }",
    "  usage: { enabled: false }",
    "  tool_calls: { enabled: false }",
    "",
  ].join("\n"),
);
await writeFile(join(project, ".gitignore"), ".kodel/runs\n.kodel/worktrees\n");
const git = (...args) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
git("init", "-q");
git("config", "user.email", "fixture@example.com");
git("config", "user.name", "Kodel Fixture");
git("add", "-A");
git("commit", "-q", "-m", "initial");

async function connect(args) {
  const client = new Client({ name: "take-v2-manager-fixture", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [main, "--root", project, "mcp", ...args],
      cwd: project,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: join(scratch, "home"),
        KODEL_STATE_DIR: join(scratch, "state"),
        ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      },
      stderr: "ignore",
    }),
  );
  const call = async (name, input = {}) => {
    const result = await client.callTool({ name, arguments: input });
    const answer = JSON.parse(result.content[0].text);
    if (answer.ok !== true) throw new Error(`${name}: ${answer.code}: ${answer.message}`);
    return answer;
  };
  return { call, close: () => client.close() };
}

/** A run of `gated` started through a worker's server and left waiting at its gate. */
async function toTheGate(task) {
  const worker = await connect(["--role", "worker"]);
  const runId = (await worker.call("pipeline_start", { task, pipeline: "gated" })).run_id;
  await worker.call("pipeline_complete_step", { run_id: runId, node_slug: "write", attempt: 1 });
  await worker.close();
  return runId;
}

/** What a manager's inbox lists for a run, by kind. */
async function inboxItem(manager, runId, kind) {
  const inbox = await manager.call("manager_inbox");
  const item = inbox.waiting.find((entry) => entry.kind === kind && entry.run_id === runId);
  if (item === undefined) throw new Error(`the inbox has no ${kind} of ${runId}`);
  return item;
}

// The first run: its gate is approved through a manager's server. Nothing is served after the decision,
// so the run is left open at `ship` with nobody on it.
const gateRun = await toTheGate("gate decided through a manager");
// The second run: the worker proposes a change of its pipeline and hands its step in; the change is
// accepted through the same manager's server, and the run is left open at `ship`.
const worker = await connect(["--role", "worker"]);
const changeRun = (
  await worker.call("pipeline_start", {
    task: "change accepted through a manager",
    pipeline: "two",
  })
).run_id;
await worker.call("pipeline_propose_change", {
  run_id: changeRun,
  pipeline: two("ship it with a note"),
  summary: "The last step also writes a note.",
});
await worker.call("pipeline_complete_step", { run_id: changeRun, node_slug: "write", attempt: 1 });
await worker.close();

const manager = await connect(["--role", "manager"]);
const gate = await inboxItem(manager, gateRun, "gate");
await manager.call("pipeline_decide_gate", {
  run_id: gateRun,
  node_slug: gate.node_slug,
  attempt: gate.attempt,
  decision: "approved",
  instruction: "approve it",
});
const change = await inboxItem(manager, changeRun, "pipeline_change");
await manager.call("pipeline_accept_change", {
  run_id: changeRun,
  change_hash: change.hash,
  instruction: "accept the change",
});
await manager.close();

// The third run: its gate is approved by an agent through a server with no role, where the run is worked.
// The answer hands that agent the next step, so the decision carries no `decided_via`.
const ownRun = await toTheGate("gate decided where the run is worked");
const own = await connect([]);
const waiting = await own.call("pipeline_next_step", { run_id: ownRun });
await own.call("pipeline_decide_gate", {
  run_id: ownRun,
  node_slug: waiting.waiting.node_slug,
  attempt: waiting.waiting.attempt,
  decision: "approved",
  instruction: "approve it",
});
await own.close();

const ids = [gateRun, changeRun, ownRun];
const runs = ids.map((id) => join(project, ".kodel", "runs", id));
execFileSync("node", [join(root, "scripts", "take-format-fixture.mjs"), "v2-manager", ...runs], {
  stdio: "inherit",
});
console.log(
  `the runs ${gateRun} (gate, through a manager), ${changeRun} (pipeline change, through a manager) and ${ownRun} (gate, by the run's own agent) are in fixtures/formats/v2-manager/`,
);
if (keep) console.log(`kept: ${scratch}`);
else await rm(scratch, { recursive: true, force: true });
