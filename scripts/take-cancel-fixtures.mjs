// Make the golden runs of a canceled run (NE3N, fixtures/formats/v1-cancel/ and v2-cancel/), and take them
// into the repository.
//
//   bun scripts/take-cancel-fixtures.mjs [--keep]
//
// The `run_finished` record of a canceled run carries the `reason` of the cancel, and a cancel the agent
// made on the person's instruction also `decided_by: agent` and its `instruction`; format 2 adds
// `decided_via: manager`, format 1 has no such key. The runs hold both formats as the real engine wrote them.
//
// Bun, not Node: the person's cancel goes through `cancelRun` (packages/cli/src/cancel-run.ts, the path of
// `kodel run cancel`) with `LocalPipelineHost` of `@kodel-ai/local`; that command asks for a terminal, so
// it is not started as a process. The agent's cancels go through a real `kodel mcp --role manager` started
// from the sources over stdio in a scratch git repository whose config has
// `decisions: { agent: { cancel_run: true } }`; the runs are started and worked through a real
// `kodel mcp --role worker`. No `CLAUDE*` variable and no `KODEL_ENGINE` reach the servers, so no record
// names a session, and `history.agent_log`, `usage` and `tool_calls` are off in the scratch project.
//
// - v2-cancel: a run of `gated` waiting at its gate, canceled through the manager's server; and a run of
//   `gated` running at `write`, canceled by the person.
// - v1-cancel: a copy of the paused run of format 1 `fixtures/formats/v1-open/r_0mvxulvel_5xgk`, made real
//   in the scratch project (its workdir set to the project, as packages/local/test/v1-continue.test.ts does),
//   canceled through the manager's server by the current engine: it stays format 1.
//
// Then `scripts/take-format-fixture.mjs <dir> <run> ...` copies the runs and writes `hashes.json`.
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cancelRun } from "../packages/cli/src/cancel-run.ts";
import { LocalPipelineHost } from "../packages/local/src/index.ts";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("CLAUDE") || key.startsWith("KODEL_")) delete process.env[key];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The SDK is a dependency of the CLI package, not of the repository root.
const sdk = createRequire(join(root, "packages/cli/package.json"));
const sdkPath = (file) => pathToFileURL(sdk.resolve(`@modelcontextprotocol/sdk/${file}`)).href;
const { Client } = await import(sdkPath("client/index.js"));
const { StdioClientTransport } = await import(sdkPath("client/stdio.js"));
const main = join(root, "packages", "cli", "src", "main.ts");
const keep = process.argv.includes("--keep");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "kodel-cancel-")));
const project = join(scratch, "project");
const stateDir = join(scratch, "state");
await mkdir(join(project, ".kodel", "pipelines"), { recursive: true });
await mkdir(join(scratch, "home"), { recursive: true });
await mkdir(stateDir, { recursive: true });
// the person's host keeps its integrity record in the scratch, not in the person's home
process.env.KODEL_STATE_DIR = stateDir;

await writeFile(
  join(project, ".kodel", "pipelines", "gated.yaml"),
  [
    "name: gated",
    "description: a step, a gate for the person, and a last step",
    "nodes:",
    "  - { slug: write, kind: agent, prompt: write it }",
    "  - { slug: approve, kind: human, prompt: Looks fine? }",
    "  - { slug: ship, kind: agent, prompt: ship it }",
    "edges:",
    "  - { from: write, to: approve }",
    "  - { from: approve, to: ship }",
    "  - { from: approve, to: write, when: rejected }",
    "",
  ].join("\n"),
);
await writeFile(
  join(project, ".kodel", "config.yaml"),
  [
    "decisions:",
    "  agent:",
    "    cancel_run: true",
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
  const client = new Client({ name: "take-cancel-fixtures", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [main, "--root", project, "mcp", ...args],
      cwd: project,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: join(scratch, "home"),
        KODEL_STATE_DIR: stateDir,
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

// The format-1 run, made real in the scratch project before any server looks at the runs.
const V1_RUN = "r_0mvxulvel_5xgk";
const v1Dir = join(project, ".kodel", "runs", V1_RUN);
await cp(join(root, "fixtures", "formats", "v1-open", V1_RUN), v1Dir, { recursive: true });
for (const file of ["state.json", "meta.json"]) {
  const path = join(v1Dir, file);
  const data = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, `${JSON.stringify({ ...data, workdir: project }, null, 2)}\n`);
}

const worker = await connect(["--role", "worker"]);
const agentRun = (
  await worker.call("pipeline_start", { task: "canceled through a manager", pipeline: "gated" })
).run_id;
await worker.call("pipeline_complete_step", { run_id: agentRun, node_slug: "write", attempt: 1 });
const personRun = (
  await worker.call("pipeline_start", { task: "canceled by the person", pipeline: "gated" })
).run_id;
await worker.close();

const manager = await connect(["--role", "manager"]);
for (const runId of [agentRun, V1_RUN]) {
  await manager.call("manager_cancel_run", {
    run_id: runId,
    reason: "started by mistake, a duplicate of another run",
    instruction: "cancel that run",
  });
}
await manager.close();

const host = new LocalPipelineHost({ root: project, heartbeatMs: 0, environment: {} });
let opened;
const answer = await cancelRun(
  {
    open: async (runId) => {
      opened = await host.open(runId);
      return opened;
    },
    withWorkerStartLock: (fn) => fn(),
  },
  { runId: personRun, reason: "the task was declined" },
);
if (!answer.ok) throw new Error(`cancel: ${answer.error.code}: ${answer.error.message}`);
// The patch of the run is recorded in the background after the cancel, as when the command exits.
await opened.settleEndJobs(Date.now() + 30_000);

const take = (dir, ids) =>
  execFileSync(
    "node",
    [
      join(root, "scripts", "take-format-fixture.mjs"),
      dir,
      ...ids.map((id) => join(project, ".kodel", "runs", id)),
    ],
    { stdio: "inherit" },
  );
take("v2-cancel", [agentRun, personRun]);
take("v1-cancel", [V1_RUN]);
console.log(
  `the runs ${agentRun} (canceled through a manager) and ${personRun} (canceled by the person) are in fixtures/formats/v2-cancel/, ${V1_RUN} (format 1, canceled through a manager) in fixtures/formats/v1-cancel/`,
);
if (keep) console.log(`kept: ${scratch}`);
else await rm(scratch, { recursive: true, force: true });
