// Make the four golden runs of run-state format 2 (fixtures/formats/v2/) and take them into the
// repository.
//
//   bun scripts/take-v2-fixtures.mjs [--keep]
//
// Bun, not Node: the script drives the engine through `LocalPipelineHost` of `@kodel-ai/local`, the
// TypeScript sources the CLI and the MCP server are built from (the same path `kodel mcp` serves the
// agent through: `start`, `nextStep` with `serve`, `completeStep`, `reportResult`, `feedback`,
// `proposeChange`, `pendingChange`/`acceptChange`, `decideHuman`, `resume`). Nothing of the host is
// replaced: the commands of the pipelines are run by the real process executor in the run's worktree,
// the worktrees and snapshots are git's, the integrity hashes go into the scratch directory.
//
// The script stands in for two parties, and only for them:
// - the agent: it writes the files a step asks for, commits them (so that `head`, `tree` and
//   `commits` of the hand-ins are real and differ), reports findings and completes steps;
// - the person: it decides the gates, accepts the proposal and the file change, and resumes the
//   paused branch, through the host methods the `kodel gate`, `kodel pipeline changes apply` and
//   `kodel resume` commands call.
//
// What is made: a scratch git repository (a neutral author, a bare `origin` for the `sync` and
// `publish` steps) with a `package.json` whose scripts exist and pass quickly, one smoke test for
// `bun test`, the project's own `dev` pipeline (its two `publish` checks that ask GitHub left out: the
// scratch repository has no pull request; the other four run), the `fork` example with `test` failing
// once and `verify` taking 1.5 s, and a `fork-pause` pipeline whose `test` branch runs out of its one
// attempt. Then the four runs, in this order: dev with the agent's proposal, dev with a change in the
// file, fork, fork with a paused branch. Finally `scripts/take-format-fixture.mjs v2 ...` copies them
// over the runs in `fixtures/formats/v2/` and the new files are scanned for anything of this machine.
//
// Every `CLAUDE*` variable is dropped from the environment first, and the hook index does not exist in
// the scratch repository, so the executor records hold no session; `--keep` leaves the scratch
// directory for a look. The `sync` step of `dev` calls `mktemp`, which on macOS writes to the user's
// `/var/folders` temp directory whatever `TMPDIR` says: where that directory cannot be written (a
// sandbox), put GNU coreutils first on `PATH` (`PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH`),
// whose `mktemp` honours `TMPDIR`. See fixtures/formats/README.md for what each run shows.
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
/** The program that calls the host: what `executor.client` of the records names. */
const caller = { name: "take-v2-fixtures", version: pkg.version };
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

const write = async (dir, path, content) => {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
};
const append = async (dir, path, content) =>
  writeFile(join(dir, path), (await readFile(join(dir, path), "utf8")) + content);
const lines = (n, tag) =>
  Array.from({ length: n }, (_, i) => `- ${tag}, point ${i + 1}\n`).join("");

function fail(message) {
  throw new Error(message);
}

/** The text of a file with one exact line replaced; a missing line is a mistake, not a no-op. */
function replaceLine(text, from, to) {
  if (!text.includes(from)) fail(`the text has no line ${JSON.stringify(from)}`);
  return text.replace(from, to);
}

// ---------------------------------------------------------------------------------------------
// the scratch repository

const scratch = await mkdtemp(join(tmpdir(), "kodel-v2-fixtures-"));
const repo = join(scratch, "repo");
const origin = join(scratch, "origin.git");
await mkdir(repo, { recursive: true });

const devYamlText = await readFile(join(root, ".kodel", "pipelines", "dev.yaml"), "utf8");
/**
 * The `dev` pipeline without the two `publish` checks that need GitHub, and without the edge that
 * only the second of them (`on_fail: conflicts`) could take.
 */
function devPipelineForScratch(text) {
  const out = [];
  let skipping = false;
  let dropped = 0;
  for (const line of text.split("\n")) {
    if (
      line.includes("gh pr view --json baseRefName") ||
      /from: publish,.*when: conflicts/.test(line)
    ) {
      dropped += 1;
      continue;
    }
    if (line.includes("# GitHub works the answer out after the pull request is made")) {
      skipping = true;
      dropped += 1;
    }
    if (skipping) {
      if (line.includes('test "$state" != CONFLICTING')) skipping = false;
      continue;
    }
    out.push(line);
  }
  if (dropped !== 3 || skipping)
    fail("dev.yaml does not have the two GitHub checks where expected");
  return out.join("\n");
}
const devYaml = devPipelineForScratch(devYamlText);

const forkExample = await readFile(join(root, "examples", "pipelines", "fork.yaml"), "utf8");
// `verify` takes 1.5 s; `test` fails the first time it runs in a directory and passes after.
const forkYaml = replaceLine(
  replaceLine(
    forkExample,
    '    command: node -e "process.exit(0)"\n    timeout: 600',
    '    command: node -e "setTimeout(() => process.exit(0), 1500)"\n    timeout: 600',
  ),
  '    command: node -e "process.exit(0)"\n    timeout: 900',
  `    command: node -e "const fs=require('fs');if(!fs.existsSync('.test-ran')){fs.writeFileSync('.test-ran','');process.exit(1)}"\n    timeout: 900`,
);

// A fork whose `test` branch has one attempt and no second failure to spend: when `test` fails, the
// branch pauses at its failure route (into `fix-test`) while `verify` goes on. A person's `resume`
// then enters `fix-test`, and `test` passes the second time.
const forkPauseYaml = `# A fork whose test branch pauses: test has one attempt, and its failure route pauses the branch.
version: 1
name: fork-pause
description: Make a change, verify and test it at the same time; a failing test pauses its branch.
nodes:
  - slug: impl
    kind: agent
    prompt: |
      Task: {{task}}
      Make the change. Add or update tests for the changed behavior.
  - slug: verify
    kind: command
    command: node -e "setTimeout(() => process.exit(0), 2500)"
    timeout: 600
  - slug: test
    kind: command
    command: node -e "const fs=require('fs');if(!fs.existsSync('.test-ran')){fs.writeFileSync('.test-ran','');process.exit(1)}"
    timeout: 900
    max_attempts: 1
    max_consecutive_failures: 1
  - slug: fix-test
    kind: agent
    prompt: The test failed; fix the cause, then the test runs again.
  - slug: fix
    kind: agent
    join: all
    prompt: |
      Verify and test ran at the same time on your change. If a branch failed, the feedback names it
      and says why: fix the cause, then finish with the outcome restart_failed so that only the failed
      steps run again. If both passed, finish normally.
edges:
  - { from: impl, to: verify }
  - { from: impl, to: test }
  - { from: verify, to: fix }
  - { from: verify, to: fix, when: failed }
  - { from: test, to: fix }
  - { from: test, to: fix-test, when: failed }
  - { from: fix-test, to: test }
`;

git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.name", AUTHOR.name);
git(repo, "config", "user.email", AUTHOR.email);
git(repo, "config", "core.autocrlf", "false");
git(repo, "config", "commit.gpgsign", "false");
await write(
  repo,
  "README.md",
  "# fixture project\n\nA scratch project for the golden runs of kodel.\n",
);
await write(
  repo,
  "package.json",
  `${JSON.stringify(
    {
      name: "kodel-fixture-project",
      private: true,
      type: "module",
      scripts: {
        typecheck: "node -e 0",
        lint: "node -e 0",
        build: "node -e 0",
        "check:artifact": "node -e 0",
      },
    },
    null,
    2,
  )}\n`,
);
await write(
  repo,
  "tests/smoke.test.js",
  'import { expect, test } from "bun:test";\n\ntest("smoke", () => {\n  expect(1 + 1).toBe(2);\n});\n',
);
await write(
  repo,
  ".gitignore",
  "node_modules\n/.kodel/runs\n/.kodel/proposals\n/.kodel/worktrees\n/.kodel/sessions.jsonl\n/.kodel/hooks.log\n.test-ran\n.verify-ran\n",
);
await write(
  repo,
  ".kodel/config.yaml",
  [
    "version: 1",
    "worktree: { mode: auto }",
    "history:",
    "  prompts: { enabled: true }",
    "  executor: { enabled: true }",
    // no agent runs here, so there is no conversation log to copy
    "  agent_log: { enabled: false }",
    "",
  ].join("\n"),
);
await write(repo, ".kodel/pipelines/dev.yaml", devYaml);
await write(repo, ".kodel/pipelines/fork.yaml", forkYaml);
await write(repo, ".kodel/pipelines/fork-pause.yaml", forkPauseYaml);
git(repo, "add", "-A");
git(repo, "commit", "-q", "-s", "-m", "Base of the fixture project");
git(scratch, "init", "-q", "--bare", origin);
git(repo, "remote", "add", "origin", origin);
git(repo, "push", "-q", "-u", "origin", "main");

// ---------------------------------------------------------------------------------------------
// the host and how the two parties act on a run

const host = new LocalPipelineHost({
  root: repo,
  build,
  integrityDir: join(scratch, "integrity"),
  environment: process.env,
});

async function startRun(pipeline, task, title) {
  const started = await host.start({
    pipeline,
    task,
    restart: false,
    caller,
    ...(title === undefined ? {} : { title }),
  });
  if (started.status !== "started") fail(`${pipeline}: the run was not started: ${started.status}`);
  const run = await host.open(started.run.runId);
  if (!run) fail(`${pipeline}: the run ${started.run.runId} cannot be opened`);
  const workdir = (await run.state()).workdir;
  if (typeof workdir !== "string") fail(`${pipeline}: the run has no worktree`);
  return { run, workdir };
}

/** The next answer that is not `running`, each one served (and so recorded) as the MCP tool serves it. */
async function next(run) {
  for (let i = 0; i < 300; i += 1) {
    const answer = await run.nextStep({ serve: { caller } });
    if (!("running" in answer)) return answer;
    await run.waitForRest(120_000);
  }
  fail(`run ${run.runId} did not settle`);
}

async function step(run, slug, attempt) {
  const answer = await next(run);
  if (!("node" in answer) || answer.node.slug !== slug || answer.node.attempt !== attempt) {
    fail(`expected ${slug} #${attempt}, got ${JSON.stringify(answer).slice(0, 400)}`);
  }
  return answer.node;
}

async function waiting(run, slug, reason) {
  const answer = await next(run);
  if (
    !("waiting" in answer) ||
    answer.waiting.node_slug !== slug ||
    answer.waiting.reason !== reason
  ) {
    fail(`expected waiting (${reason}) at ${slug}, got ${JSON.stringify(answer).slice(0, 400)}`);
  }
  return answer.waiting;
}

async function done(run) {
  const answer = await next(run);
  if (!("done" in answer) || answer.run_status !== "completed") {
    fail(`expected the run to be completed, got ${JSON.stringify(answer).slice(0, 400)}`);
  }
  await run.waitForRest(120_000);
}

const must = (decision, what) => {
  if (!decision.ok) fail(`${what} refused: ${decision.error.code}: ${decision.error.message}`);
  return decision;
};

async function complete(run, slug, attempt, outcome) {
  must(await run.completeStep(slug, attempt, undefined, outcome, caller), `${slug} #${attempt}`);
  await run.waitForRest(120_000);
}

async function report(run, slug, attempt, rows) {
  const result = await run.reportResult(slug, attempt, { rows, completeness: "complete" });
  if (!result.ok) fail(`report of ${slug} #${attempt} refused: ${result.code}: ${result.message}`);
}

async function decide(run, slug, decision, reason) {
  must(await run.decideHuman(slug, decision, reason), `${decision} of ${slug}`);
  await run.waitForRest(120_000);
}

const commit = (workdir, message) => {
  git(workdir, "add", "-A");
  git(workdir, "commit", "-q", "-s", "-m", message);
};

/** The plan file the prompt of a `dev` step names. */
const planPath = (node) =>
  node.prompt.match(/docs\/plans\/[\w-]+\.md/)?.[0] ?? fail(`no plan path in ${node.slug}`);

// ---------------------------------------------------------------------------------------------
// run 1: dev, the agent's proposal accepted while the critique step was being worked

async function devWithProposal() {
  const task = "Add a --json flag to kodel status so that scripts can read the list of runs";
  const { run, workdir } = await startRun("dev", task);
  let node = await step(run, "plan", 1);
  const plan = planPath(node);
  must(
    await run.feedback({
      node: "plan",
      attempt: 1,
      category: "unclear_prompt",
      message:
        "The prompt asks for docs/plans/<slug>.md but does not say whether the docs/plans directory may be created when it does not exist yet.",
      suggestion: "Say that the directory is made if it is missing.",
    }),
    "feedback",
  );
  await write(
    workdir,
    plan,
    `# A --json flag for kodel status\n\n## TL;DR\n\n${lines(12, "the status command prints the run list as JSON")}`,
  );
  commit(workdir, "Write the plan");
  await complete(run, "plan", 1);

  node = await step(run, "plan-critique", 1);
  // The agent proposes a change of the step it is on; the person accepts it, and the step is restarted.
  const proposal = replaceLine(
    devYaml,
    "      Take what the subagents find as it is; do not soften it, merge it away or drop a finding that",
    '      Check every question in "Decisions needed" too: the person reads them first.\n      Take what the subagents find as it is; do not soften it, merge it away or drop a finding that',
  );
  const proposed = await run.proposeChange({
    yaml: proposal,
    summary:
      "plan-critique: the critique should also check the open decisions the plan lists, since the person reads them first.",
  });
  if (!proposed.ok || proposed.status !== "proposed") {
    fail(`the proposal was not taken: ${JSON.stringify(proposed).slice(0, 300)}`);
  }
  const pending = await run.pendingChange(undefined, "proposal");
  if (!pending) fail("the proposal is not pending");
  must(
    await run.acceptChange({
      source: "proposal",
      text: pending.text,
      reason: "agreed: the decisions are what I read first",
      standing: pending.info.standing,
    }),
    "accepting the proposal",
  );
  await run.waitForRest(120_000);

  node = await step(run, "plan-critique", 2);
  await report(run, "plan-critique", 2, [
    {
      severity: "minor",
      location: `${plan}:3`,
      description: "[scope] the TL;DR does not say what the flag costs",
    },
  ]);
  await complete(run, "plan-critique", 2);

  node = await step(run, "plan-revise", 1);
  await append(workdir, plan, "\n## Decisions needed\n\nNone.\n");
  commit(workdir, "Answer the critique of the plan");
  await complete(run, "plan-revise", 1);

  await waiting(run, "plan-approval", "gate");
  await decide(run, "plan-approval", "rejected", "the plan does not say how the flag is tested");

  node = await step(run, "plan", 2);
  await append(
    workdir,
    plan,
    `\n## Acceptance criteria and tests\n\n${lines(11, "status --json is covered by a CLI test")}`,
  );
  commit(workdir, "Make the plan again with the tests");
  await complete(run, "plan", 2);

  node = await step(run, "plan-critique", 3);
  await report(run, "plan-critique", 3, []);
  await complete(run, "plan-critique", 3);

  node = await step(run, "plan-revise", 2);
  await append(workdir, plan, "\n## Rejected review findings\n\nNone.\n");
  commit(workdir, "Keep the plan after the second critique");
  await complete(run, "plan-revise", 2);

  await waiting(run, "plan-approval", "gate");
  await decide(run, "plan-approval", "approved");

  node = await step(run, "impl", 1);
  await write(
    workdir,
    "packages/status/json.js",
    "export function asJson(runs) {\n  return JSON.stringify(runs, null, 2);\n}\n",
  );
  await write(
    workdir,
    "tests/status-json.test.js",
    'import { expect, test } from "bun:test";\nimport { asJson } from "../packages/status/json.js";\n\ntest("status --json lists the runs", () => {\n  expect(JSON.parse(asJson([{ runId: "r_1" }]))).toEqual([{ runId: "r_1" }]);\n});\n',
  );
  commit(workdir, "Add the --json flag to status");
  await complete(run, "impl", 1);

  // verify, test and build ran for real; the review finds nothing blocking
  node = await step(run, "review", 1);
  await report(run, "review", 1, [
    {
      severity: "info",
      location: "packages/status/json.js:1",
      description: "the function could take the indent as an argument",
    },
  ]);
  await complete(run, "review", 1);

  // sync ran for real against origin/main
  await waiting(run, "final-approval", "gate");
  await decide(run, "final-approval", "approved");

  node = await step(run, "publish", 1);
  git(workdir, "push", "-q", "-u", "origin", "HEAD");
  await complete(run, "publish", 1);
  await done(run);
  return run.runId;
}

// ---------------------------------------------------------------------------------------------
// run 2: dev, a change made in the run's pipeline file; the plan finds nothing to change

async function devWithFileChange() {
  const task = "Document the kodel wait command in the README";
  const { run, workdir } = await startRun("dev", task);
  const node = await step(run, "plan", 1);
  const plan = planPath(node);
  // A person edits the pipeline file of the run (a step the run has not reached) and accepts it.
  const file = join(workdir, ".kodel", "pipelines", "dev.yaml");
  await writeFile(
    file,
    replaceLine(
      await readFile(file, "utf8"),
      "      Report every problem as a finding.",
      "      Report every problem as a finding, with the file and the line it is at.",
    ),
  );
  const pending = await run.pendingChange(undefined, "file");
  if (!pending) fail("the change in the file is not pending");
  must(
    await run.acceptChange({
      source: "file",
      text: pending.text,
      reason: "the reviewer should say where",
      standing: pending.info.standing,
    }),
    "accepting the file change",
  );
  await run.waitForRest(120_000);
  must(
    await run.feedback({
      node: "plan",
      attempt: 1,
      category: "missing_step",
      message: "There is no step that checks the README renders; a docs change has no test here.",
    }),
    "feedback",
  );
  await write(
    workdir,
    plan,
    `# Document kodel wait\n\n## TL;DR\n\nNothing to change: the README documents the command already.\n\n## Evidence\n\n${lines(10, "README.md names kodel wait")}`,
  );
  commit(workdir, "Write the plan: nothing to change");
  await complete(run, "plan", 1, "nothing_to_change");

  await waiting(run, "confirm-nothing-to-do", "gate");
  await decide(run, "confirm-nothing-to-do", "rejected", "show me where the README says it");

  await step(run, "plan", 2);
  await append(
    workdir,
    plan,
    `\n## Where the README says it\n\n${lines(10, "the section on waiting for a decision")}`,
  );
  commit(workdir, "Point at the README section");
  await complete(run, "plan", 2, "nothing_to_change");

  await waiting(run, "confirm-nothing-to-do", "gate");
  await decide(run, "confirm-nothing-to-do", "approved");
  await done(run);
  return run.runId;
}

// ---------------------------------------------------------------------------------------------
// run 3: the fork example, `test` failing once and the join restarting it

async function forkRun() {
  const { run, workdir } = await startRun(
    "fork",
    "add a greeting function and its test",
    "greeting-with-fork",
  );
  await step(run, "impl", 1);
  await write(
    workdir,
    "src/greeting.js",
    "export function greeting(name) {\n  return `Hello, ${name}!`;\n}\n",
  );
  commit(workdir, "Add the greeting function");
  await complete(run, "impl", 1);
  const join1 = await step(run, "fix", 1);
  if (!String(join1.reentry_feedback ?? "").includes('"test" failed')) {
    fail(`the join was not told that test failed: ${JSON.stringify(join1).slice(0, 400)}`);
  }
  await complete(run, "fix", 1, "restart_failed");
  await step(run, "fix", 2);
  await complete(run, "fix", 2);
  await done(run);
  return run.runId;
}

// ---------------------------------------------------------------------------------------------
// run 4: a fork whose `test` branch pauses while `verify` goes on, resumed by a person

async function forkPausedRun() {
  const { run, workdir } = await startRun(
    "fork-pause",
    "add a farewell function and its test",
    "farewell-with-paused-branch",
  );
  await step(run, "impl", 1);
  await write(
    workdir,
    "src/farewell.js",
    "export function farewell(name) {\n  return `Goodbye, ${name}.`;\n}\n",
  );
  commit(workdir, "Add the farewell function");
  await complete(run, "impl", 1);
  // `test` failed and its branch paused; `verify` finished meanwhile and the run waits for a person
  await waiting(run, "test", "paused");
  const state = await run.state();
  if (state.status !== "paused" || state.pauses.length !== 1) {
    fail(`expected one pause, got ${JSON.stringify(state.pauses)} (${state.status})`);
  }
  if (state.pauses[0]?.fork?.branch !== "test") {
    fail(`the pause is not attributed to the test branch: ${JSON.stringify(state.pauses[0])}`);
  }
  if (!state.forks?.f1?.arrived?.verify) fail("verify did not arrive at the join before the pause");
  must(await run.resume("test"), "resume");
  await run.waitForRest(120_000);
  await step(run, "fix-test", 1);
  await write(
    workdir,
    "tests/farewell.test.js",
    'import { expect, test } from "bun:test";\nimport { farewell } from "../src/farewell.js";\n\ntest("farewell", () => {\n  expect(farewell("Ada")).toBe("Goodbye, Ada.");\n});\n',
  );
  commit(workdir, "Add the farewell test");
  await complete(run, "fix-test", 1);
  await step(run, "fix", 1);
  await complete(run, "fix", 1);
  await done(run);
  return run.runId;
}

// ---------------------------------------------------------------------------------------------
// the runs, then the fixtures

const ids = [];
for (const make of [devWithProposal, devWithFileChange, forkRun, forkPausedRun]) {
  const id = await make();
  console.log(`${make.name}: ${id}`);
  ids.push(id);
}

/** Text no fixture may hold: a session of an agent, or its environment. */
const NO_SESSION = ["observed-env", "observed-hook", "CLAUDE"];
/** Nor a path of this machine; the take script puts a placeholder where the worktree was. */
const NO_PATH = [
  "/Users/",
  "/home/",
  "/var/folders",
  "/private/",
  scratch,
  await realpath(scratch),
];

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
    for (const bad of forbidden) {
      if (text.includes(bad)) fail(`${path} holds ${JSON.stringify(bad)}`);
    }
    if (/"session"\s*:\s*\{\s*"value"/.test(text)) fail(`${path} holds a session`);
  }
}

const runsDir = join(repo, ".kodel", "runs");
const target = join(root, "fixtures", "formats", "v2");
for (const id of ids) await scan(join(runsDir, id), NO_SESSION);
for (const entry of await readdir(target, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.startsWith("r_")) {
    await rm(join(target, entry.name), { recursive: true, force: true });
  }
}
execFileSync(
  "node",
  [join(root, "scripts", "take-format-fixture.mjs"), "v2", ...ids.map((id) => join(runsDir, id))],
  { stdio: "inherit" },
);
for (const id of ids) await scan(join(target, id), [...NO_SESSION, ...NO_PATH]);
console.log(`taken into ${target}: ${ids.join(" ")}`);

if (keep) console.log(`scratch kept at ${scratch}`);
else await rm(scratch, { recursive: true, force: true });
