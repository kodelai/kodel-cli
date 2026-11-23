// Make the golden run of run-state format 2 with attachments (fixtures/formats/v2-attachment/, T-45), and take
// it into the repository.
//
//   bun scripts/take-v2-attachment-fixture.mjs [--keep]
//
// Bun, not Node: the script drives `LocalPipelineHost` of `@kodel-ai/local` (the TypeScript sources `kodel mcp` is
// built from) with nothing replaced. It plays the agent (the plan written twice with `writeAttachment`, a PNG named
// by its path in the run's working directory, the step handed in) and the person (`decideHuman` at the gate). The
// first plan is too short for the step's `attachment` check, so the run holds a failed check, a second version in
// the same visit, and the check passing. Then `scripts/take-format-fixture.mjs v2-attachment <run>` copies the run
// and rewrites `hashes.json`.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalPipelineHost } from "../packages/local/src/index.ts";
import { defaultAgentLog, defaultHistory } from "../packages/pipeline-core/src/index.ts";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("CLAUDE")) delete process.env[key];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "kodel-v2-attachment-")));
const project = join(scratch, "project");
const state = join(scratch, "state");
await mkdir(join(project, ".kodel", "pipelines"), { recursive: true });
await mkdir(state, { recursive: true });
// the integrity record of the host goes to the scratch, not to the person's home
process.env.KODEL_STATE_DIR = state;

await writeFile(
  join(project, ".kodel", "pipelines", "attach.yaml"),
  [
    "name: attach",
    "description: a plan kept with the run, checked, shown at a gate and read by a later step",
    "nodes:",
    "  - slug: plan",
    "    kind: agent",
    "    prompt: Write the plan for {{task}} and keep it with the run.",
    "    checks:",
    "      - { kind: attachment, name: plan.md, min_lines: 3 }",
    "  - { slug: approval, kind: human, prompt: Is the plan right? }",
    "  - { slug: impl, kind: agent, prompt: Do what the plan says. }",
    "edges:",
    "  - { from: plan, to: approval }",
    "  - { from: approval, to: impl, when: approved }",
    "  - { from: approval, to: plan, when: rejected }",
    "",
  ].join("\n"),
);
const git = (...args) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
git("init", "-q");
git("config", "user.email", "fixture@example.com");
git("config", "user.name", "Kodel Fixture");
git("add", ".");
git("commit", "-q", "-m", "initial");

const host = new LocalPipelineHost({
  root: project,
  heartbeatMs: 0,
  environment: {},
  build: { version: "0.1.0", commit: "fixture" },
  history: {
    ...defaultHistory(),
    // no copy of the agent's log and no record of who ran the steps: both would name this machine
    agent_log: { ...defaultAgentLog(), enabled: false },
    executor: { enabled: false },
  },
});

const fail = (message) => {
  throw new Error(message);
};
const started = await host.start({ pipeline: "attach", task: "keep a plan", restart: false });
const run = await host.open(started.run.runId);
const runId = run.runId;
const workdir = (await run.state()).workdir;
if (typeof workdir !== "string") fail("the run has no workdir");

await run.nextStep({ serve: {} });
// the first plan is too short: the check fails and the step is tried again, in the same visit
await run.writeAttachment({
  node: "plan",
  attempt: 1,
  name: "plan.md",
  content: "# Plan\n1. Read the command.\n",
});
await run.completeStep("plan", 1, "a first plan");
await run.settle();
if ((await run.state()).nodes.plan.attempt !== 2) fail("the short plan passed its check");
await run.nextStep({ serve: {} });
await run.writeAttachment({
  node: "plan",
  attempt: 2,
  name: "plan.md",
  content: "# Plan\n\n1. Read the command.\n2. Change it.\n3. Test it.\n",
});
// a screenshot: a file the agent made in the run's working directory, named by its path
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
await writeFile(join(workdir, "shot.png"), PNG);
await run.writeAttachment({ node: "plan", attempt: 2, name: "shot.png", path: "shot.png" });
await rm(join(workdir, "shot.png"));
await run.completeStep("plan", 2, "the plan, and a screenshot");
await run.settle();

const atGate = await run.nextStep({ serve: {} });
if (!("waiting" in atGate) || atGate.waiting.attachments?.length !== 2) {
  fail(`the gate does not list the two attachments: ${JSON.stringify(atGate)}`);
}
const decided = await run.decideHuman("approval", "approved");
if (!decided.ok) fail(decided.error.message);
await run.settle();

await run.nextStep({ serve: {} });
const read = await run.readAttachment({ name: "plan.md" });
if (read.attachment.version !== 2 || !read.content?.includes("3. Test it.")) {
  fail("the later step does not read the plan the gate showed");
}
await run.completeStep("impl", 1, "done as the plan says");
await run.settle();

const finished = await run.state();
if (finished.status !== "completed") fail(`the run ended ${finished.status}, not completed`);
await host.settle(30_000);
const dir = join(project, ".kodel", "runs", runId);
execFileSync("node", [join(root, "scripts", "take-format-fixture.mjs"), "v2-attachment", dir], {
  stdio: "inherit",
});
console.log(`the run ${runId} is in fixtures/formats/v2-attachment/`);
if (keep) console.log(`kept: ${scratch}`);
else await rm(scratch, { recursive: true, force: true });
