// Make the two golden runs that carry `run_started.origin` and the journal event `agent_stopped`
// (fixtures/formats/v2-origin/) and take them into the repository.
//
//   bun scripts/take-v2-origin-fixture.mjs [--keep]
//
// Bun, not Node: like `take-v2-fixtures.mjs` it drives the engine through `LocalPipelineHost` of
// `@kodel-ai/local`. Nothing of the host is replaced; the script stands in for the path of the call (it gives
// the `origin` a TUI key or a manager's tool would), the agent (it completes the steps) and the person (it
// decides the gate). A scratch git repository with the one pipeline `gated` is made; no `CLAUDE*` variable
// reaches the host, so no record names a session. Then `scripts/take-format-fixture.mjs v2-origin ...` copies
// the runs and the new files are scanned for anything of this machine.
//
// - run 1 (open): started as an agent through a manager would (`by: agent`, `via: manager`, the agent's
//   words, `forced: [full, conflict]`), then the host journals `agent_stopped`; it is left at `write`.
// - run 2 (finished): started by a person at the TUI (`by: person`, `via: tui`), worked to its end.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalPipelineHost } from "../packages/local/src/index.ts";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("CLAUDE")) delete process.env[key];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const pkg = JSON.parse(await readFile(join(root, "packages", "cli", "package.json"), "utf8"));
const caller = { name: "take-v2-origin-fixture", version: pkg.version };
const build = { version: pkg.version, commit: "fixture" };

const AUTHOR = { name: "Kodel Fixture", email: "fixture@example.com" };
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
};
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
const fail = (message) => {
  throw new Error(message);
};
const write = async (dir, path, content) => {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
};

const scratch = await mkdtemp(join(tmpdir(), "kodel-v2-origin-"));
const repo = join(scratch, "repo");
await mkdir(repo, { recursive: true });
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.name", AUTHOR.name);
git(repo, "config", "user.email", AUTHOR.email);
git(repo, "config", "commit.gpgsign", "false");
await write(repo, "README.md", "# fixture project\n");
await write(repo, ".gitignore", "/.kodel/runs\n/.kodel/proposals\n/.kodel/worktrees\n");
await write(
  repo,
  ".kodel/config.yaml",
  "version: 1\nworktree: { mode: auto }\nhistory:\n  executor: { enabled: true }\n  agent_log: { enabled: false }\n",
);
await write(
  repo,
  ".kodel/pipelines/gated.yaml",
  `version: 1
name: gated
description: an agent step, a gate, an agent step
nodes:
  - slug: write
    kind: agent
    prompt: Do {{task}}.
  - slug: review
    kind: human
    prompt: Look at it.
  - slug: ship
    kind: agent
    prompt: Ship it.
edges:
  - { from: write, to: review }
  - { from: review, to: ship }
  - { from: review, to: write, when: rejected }
`,
);
git(repo, "add", "-A");
git(repo, "commit", "-q", "-s", "-m", "Base of the fixture project");

const host = new LocalPipelineHost({
  root: repo,
  build,
  integrityDir: join(scratch, "integrity"),
  environment: process.env,
});

async function startRun(task, title, origin) {
  const started = await host.start({
    pipeline: "gated",
    task,
    restart: false,
    title,
    caller,
    origin,
  });
  if (started.status !== "started") fail(`${title}: not started: ${started.status}`);
  const run = await host.open(started.run.runId);
  if (!run) fail(`${title}: cannot be opened`);
  return run;
}

async function next(run) {
  for (let i = 0; i < 300; i += 1) {
    const answer = await run.nextStep({ serve: { caller } });
    if (!("running" in answer)) return answer;
    await run.waitForRest(120_000);
  }
  fail(`run ${run.runId} did not settle`);
}
const must = (decision, what) => {
  if (!decision.ok) fail(`${what} refused: ${decision.error.code}: ${decision.error.message}`);
  return decision;
};
const complete = async (run, slug, attempt) => {
  must(await run.completeStep(slug, attempt, undefined, undefined, caller), slug);
  await run.waitForRest(120_000);
};

// run 1: an agent started it through a manager, then stopped its agent
const first = await startRun("Add a flag to the status command", "agent-started", {
  by: "agent",
  via: "manager",
  agent_instruction: "the person asked to start TASK-AB12 now, although another run is going",
  forced: ["full", "conflict"],
});
const stop = await first.noteAgentStopped({
  instruction: "the person asked to stop the agent of this run",
});
if (!stop.written) fail("agent_stopped was not written");
const served = await next(first);
if (!("node" in served) || served.node.slug !== "write") fail("run 1 is not at write");

// run 2: a person started it at the TUI and it ran to its end
const second = await startRun("Fix the title of the report", "person-started", {
  by: "person",
  via: "tui",
});
let answer = await next(second);
if (!("node" in answer) || answer.node.slug !== "write") fail("run 2 is not at write");
await complete(second, "write", 1);
answer = await next(second);
if (!("waiting" in answer)) fail("run 2 does not wait at the gate");
must(await second.decideHuman("review", "approved", "looks fine"), "the gate");
await second.waitForRest(120_000);
answer = await next(second);
if (!("node" in answer) || answer.node.slug !== "ship") fail("run 2 is not at ship");
await complete(second, "ship", 1);
answer = await next(second);
if (!("done" in answer) || answer.run_status !== "completed") fail("run 2 did not finish");
await second.waitForRest(120_000);

const ids = [first.runId, second.runId];
const runsDir = join(repo, ".kodel", "runs");
const target = join(root, "fixtures", "formats", "v2-origin");
const NO_PATH = [
  "/Users/",
  "/home/",
  "/var/folders",
  "/private/",
  scratch,
  await realpath(scratch),
];
const NO_SESSION = ["observed-env", "observed-hook", "CLAUDE"];

async function files(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else found.push(path);
  }
  return found;
}
async function scan(dir, forbidden) {
  for (const path of await files(dir)) {
    const text = await readFile(path, "utf8");
    for (const bad of forbidden)
      if (text.includes(bad)) fail(`${path} holds ${JSON.stringify(bad)}`);
  }
}

for (const id of ids) await scan(join(runsDir, id), NO_SESSION);
await mkdir(target, { recursive: true });
for (const entry of await readdir(target, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.startsWith("r_")) {
    await rm(join(target, entry.name), { recursive: true, force: true });
  }
}
execFileSync(
  "node",
  [
    join(root, "scripts", "take-format-fixture.mjs"),
    "v2-origin",
    ...ids.map((id) => join(runsDir, id)),
  ],
  { stdio: "inherit" },
);
for (const id of ids) await scan(join(target, id), [...NO_SESSION, ...NO_PATH]);
console.log(`taken into ${target}: ${ids.join(" ")}`);
if (keep) console.log(`scratch kept at ${scratch}`);
else await rm(scratch, { recursive: true, force: true });
