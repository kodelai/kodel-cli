// Make the golden run of run-state format 2 with an engine step (fixtures/formats/v2-engine/, T-42)
// and take it into the repository.
//
//   bun scripts/take-v2-engine-fixture.mjs [--keep]
//
// Bun, not Node: the script drives `LocalPipelineHost` of `@kodel-ai/local` (the TypeScript sources
// `kodel mcp` is built from) with engine steps turned on as the MCP server turns them on
// (`engineSteps: { start: true }`), and the real `PipesSessionAdapter` with its holder started from
// `packages/local/src/session-holder-entry.ts`. The engine's program is a Node script: it fails its
// first attempt (exit 1) and prints a JSON result on the second. The command check of the step and the
// gate run as usual; the script plays the agent (the `plan` step) and the person (`decideHuman` at the
// gate, the method `kodel gate` calls). The session records go to a scratch `KODEL_STATE_DIR`.
// Then `scripts/take-format-fixture.mjs v2-engine <run>` copies the run and rewrites `hashes.json`.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalPipelineHost, PipesSessionAdapter } from "../packages/local/src/index.ts";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("CLAUDE")) delete process.env[key];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "kodel-v2-engine-")));
const project = join(scratch, "project");
const state = join(scratch, "state");
await mkdir(join(project, ".kodel", "pipelines"), { recursive: true });
await mkdir(state, { recursive: true });

const engine = join(scratch, "engine.mjs");
const counter = join(scratch, "attempts");
const quick = join(scratch, "quick.mjs");
await writeFile(quick, "process.stdout.write(JSON.stringify({ summary: 'reviewed again' }));\n");
await writeFile(
  engine,
  [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    `const file = ${JSON.stringify(counter)};`,
    "const n = existsSync(file) ? Number(readFileSync(file, 'utf8')) + 1 : 1;",
    "writeFileSync(file, String(n));",
    "if (n === 1) { process.stdout.write('not ready yet'); process.exitCode = 1; }",
    "else if (n >= 3) setTimeout(() => process.stdout.write(JSON.stringify({ summary: 'late' })), 60_000);",
    "else process.stdout.write(JSON.stringify({ summary: 'reviewed: nothing blocks', findings: 0 }));",
    "",
  ].join("\n"),
);
await writeFile(
  join(project, ".kodel", "config.yaml"),
  [
    "version: 1",
    "storage: project",
    "history: { output: { enabled: true, max_kb: 64 }, changes: { enabled: false } }",
    "engines:",
    "  reviewer:",
    `    command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(engine)}]`,
    "    timeout: 60",
    "  quick:",
    `    command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(quick)}]`,
    "    timeout: 60",
    "",
  ].join("\n"),
);
await writeFile(
  join(project, ".kodel", "pipelines", "engine-unknown.yaml"),
  [
    "name: engine-unknown",
    "description: an agent step, an engine step whose first outcome is unknown, a gate",
    "nodes:",
    "  - slug: plan",
    "    kind: agent",
    "    prompt: Plan {{task}}.",
    "  - slug: review",
    "    kind: agent",
    "    engine: quick",
    "    prompt: Review the plan for {{task.slug}}.",
    "  - slug: approve",
    "    kind: human",
    "    prompt: Approve the review?",
    "edges:",
    "  - { from: plan, to: review }",
    "  - { from: review, to: approve }",
    "  - { from: approve, to: review, when: rejected }",
    "",
  ].join("\n"),
);
await writeFile(
  join(project, ".kodel", "pipelines", "engine.yaml"),
  [
    "name: engine",
    "description: an agent step, an engine step with a check, a gate",
    "nodes:",
    "  - slug: plan",
    "    kind: agent",
    "    prompt: Plan {{task}}.",
    "  - slug: review",
    "    kind: agent",
    "    engine: reviewer",
    "    prompt: Review the plan for {{task.slug}}.",
    "    max_consecutive_failures: 2",
    "    checks:",
    "      - kind: command",
    "        command: node -e 0",
    "  - slug: approve",
    "    kind: human",
    "    prompt: Approve the review?",
    "edges:",
    "  - { from: plan, to: review }",
    "  - { from: review, to: approve }",
    "  - { from: approve, to: review, when: rejected }",
    "",
  ].join("\n"),
);

const git = (...args) =>
  execFileSync("git", args, {
    cwd: project,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Kodel Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Kodel Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  });
await writeFile(join(project, ".gitignore"), ".kodel/runs/\n.kodel/worktrees/\n");
git("init", "-q", "-b", "main");
git("add", ".");
git("commit", "-q", "-m", "initial");
const env = { ...process.env, KODEL_STATE_DIR: state };
const entry = join(root, "packages", "local", "src", "session-holder-entry.ts");
const sessions = ({ rules, bootTimeoutMs }) =>
  new PipesSessionAdapter({
    base: state,
    root: project,
    baseEnv: env,
    holder: { exec: process.execPath, args: [entry, "holder"] },
    intermediate: { exec: process.execPath, args: [entry] },
    rules,
    bootTimeoutMs,
  });
const host = new LocalPipelineHost({
  root: project,
  storeRoot: join(project, ".kodel"),
  integrityDir: join(scratch, "integrity"),
  environment: env,
  build: { version: "0.1.0", commit: "fixture" },
  // The owner of an engine visit is kept in the state: a neutral name, not this machine's.
  ownerId: "fixture-host:1",
  engine: { engineSteps: { start: true } },
  engineSessions: ({ rules, bootTimeoutMs }) =>
    new PipesSessionAdapter({
      base: state,
      root: project,
      baseEnv: env,
      holder: { exec: process.execPath, args: [entry, "holder"] },
      intermediate: { exec: process.execPath, args: [entry] },
      rules,
      bootTimeoutMs,
    }),
});

const started = await host.start({
  pipeline: "engine",
  task: "Add a health check",
  restart: false,
});
if (started.status !== "started") throw new Error(`not started: ${started.status}`);
const runId = started.run.runId;
const run = await host.open(runId);
if (!run) throw new Error("the run cannot be opened");
await run.nextStep({ serve: {} });
const done = await run.completeStep("plan", 1, "a plan");
if (!done.ok) throw done.error;
// The engine step fails once, is entered again and passes; its check runs; the gate waits.
for (let i = 0; i < 300; i++) {
  await run.settle();
  const now = await run.state();
  if (now.active.some((v) => v.phase === "human")) break;
  await run.tick();
  await new Promise((r) => setTimeout(r, 100));
}
const gate = await run.decideHuman("approve", "approved");
if (!gate.ok) throw gate.error;
await run.settle();
const final = await run.state();
if (final.status !== "completed") throw new Error(`the run is ${final.status}`);

// A second run is left open while its engine step runs: its state holds the open record with the
// session's id. The session is stopped once the run is taken.
const second = await host.start({
  pipeline: "engine",
  task: "Add a readiness check",
  restart: false,
});
if (second.status !== "started") throw new Error(`not started: ${second.status}`);
const open = await host.open(second.run.runId);
if (!open) throw new Error("the second run cannot be opened");
await open.nextStep({ serve: {} });
const planned = await open.completeStep("plan", 1, "another plan");
if (!planned.ok) throw planned.error;
let sessionId;
for (let i = 0; i < 100 && sessionId === undefined; i++) {
  sessionId = (await open.state()).engineSession?.id;
  await new Promise((r) => setTimeout(r, 100));
}
if (sessionId === undefined) throw new Error("the engine step of the second run did not start");
open.stop();
await new Promise((r) => setTimeout(r, 300));

// A third run whose engine step's outcome is unknown, then resumed by the person: a person's host
// enters the step (no record); a starting host writes the record and dies before `start()` (its
// resolver never answers); the next server takes the waiting over (`engine_session_joined`), lists
// no session of the name and pauses the run (`work_unknown`, `source: session`); the person's
// `resume` looks the session up, finds none and clears the record (`run_resumed.session`); the server
// starts the new attempt, which passes, and the gate is approved.
const hostAs = (start, ownerId, extra = {}) =>
  new LocalPipelineHost({
    root: project,
    storeRoot: join(project, ".kodel"),
    integrityDir: join(scratch, "integrity"),
    environment: env,
    build: { version: "0.1.0", commit: "fixture" },
    ownerId,
    isOwnerAlive: (owner) => owner !== "fixture-gone:1",
    engine: { engineSteps: { start } },
    engineSessions: sessions,
    ...extra,
  });
const person = hostAs(false, "fixture-person:1");
const third = await person.start({
  pipeline: "engine-unknown",
  task: "Add a liveness check",
  restart: false,
});
if (third.status !== "started") throw new Error(`not started: ${third.status}`);
const thirdId = third.run.runId;
const byPerson = await person.open(thirdId);
await byPerson.nextStep({ serve: {} });
const planned3 = await byPerson.completeStep("plan", 1, "a third plan");
if (!planned3.ok) throw planned3.error;
const issuer = hostAs(true, "fixture-gone:1", {
  engineResolver: { resolve: () => new Promise(() => undefined) },
});
const pending = await (await issuer.open(thirdId)).apply({
  type: "engine_start_pending",
  node: "review",
  attempt: 1,
});
if (!pending.ok) throw pending.error;
const server = hostAs(true, "fixture-host:2");
const byServer = await server.open(thirdId);
for (let i = 0; i < 100 && (await byServer.state()).status !== "paused"; i++) {
  await byServer.tick();
  await byServer.settle();
}
if ((await byServer.state()).status !== "paused") throw new Error("the third run did not pause");
const resumed = await byPerson.resume();
if (!resumed.ok) throw resumed.error;
for (let i = 0; i < 300; i++) {
  await byServer.tick();
  await byServer.settle();
  if ((await byServer.state()).active.some((v) => v.phase === "human")) break;
  await new Promise((r) => setTimeout(r, 100));
}
const approved = await byPerson.decideHuman("approve", "approved");
if (!approved.ok) throw approved.error;
if ((await byPerson.state()).status !== "completed") throw new Error("the third run did not end");

execFileSync(
  "node",
  [
    join(root, "scripts", "take-format-fixture.mjs"),
    "v2-engine",
    join(project, ".kodel", "runs", runId),
    join(project, ".kodel", "runs", second.run.runId),
    join(project, ".kodel", "runs", thirdId),
  ],
  { stdio: "inherit" },
);
await new PipesSessionAdapter({
  base: state,
  root: project,
  baseEnv: env,
  holder: { exec: process.execPath, args: [entry, "holder"] },
  intermediate: { exec: process.execPath, args: [entry] },
})
  .stop(sessionId)
  // Where the identity of the child cannot be read (a sandbox without `ps`), it ends by itself at its timeout.
  .catch((error) => console.error(`the session ${sessionId} was not stopped: ${error.message}`));
console.log(`taken: ${runId}; sessions: ${(await readdir(join(state, "run"))).join(", ")}`);
if (!keep) await rm(scratch, { recursive: true, force: true });
// The issuer of the third run waits on a resolver that never answers; nothing else is left to do.
process.exit(0);
