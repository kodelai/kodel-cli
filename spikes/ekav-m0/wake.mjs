// Criterion 5: a background `kodel wait` that reports wakes the idle interactive session.
// A throwaway project with a run at a gate; the session is told to drive the run, so the server's own
// text sends it to `kodel wait <run>` in the background. After <delay> seconds of idleness the spike
// decides the gate (decide.ts, the calls `kodel gate` makes) and watches whether the session goes on.
// NEEDS A SIGNED-IN claude.
//   node wake.mjs <trusted parent> [delay seconds, default 30]       an hour: node wake.mjs <parent> 3600
import fs from "node:fs";
import path from "node:path";
import {
  ALLOWED,
  ARTIFACT,
  agentEnv,
  CLAUDE,
  DENIED,
  mcpCall,
  open,
  project,
  quit,
  sh,
  sleep,
  transcriptOf,
  uuid,
  workerFlags,
} from "./lib.mjs";

const [parent, delayArg] = process.argv.slice(2);
const delayS = Number(delayArg ?? 30);
const p = project(parent);
const run = mcpCall(p, "pipeline_start", {
  pipeline: "mini",
  task: "spike: nothing to do",
  title: "ekav-spike",
});
const runId = run.run_id;
console.log("project", p.root, "run", runId);
if (!runId) process.exit(1);

const id = uuid();
const prompt =
  `Kodel run ${runId} exists and is yours to drive. Call pipeline_next_step with run_id ${runId} and do what each answer says; ` +
  `never call pipeline_start. Work in ${p.root}.`;
// `wait r_*` is on today's deny list (claude-worker.ts); step 3 of the plan drops it for terminal workers.
const flags = workerFlags({ mcp: p.mcp, allowed: ALLOWED, denied: DENIED, sessionId: id });
const s = open(`c5-wake-${delayS}`, CLAUDE, [prompt, ...flags], {
  cwd: p.root,
  env: agentEnv({ PATH: `${p.bin}:${process.env.PATH}` }),
});
const file = transcriptOf(p.root, id);
const text = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const waiters = () => {
  try {
    return sh("pgrep", ["-fl", `wait ${runId}`])
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
};

let watching = false;
for (
  const until = Date.now() + 180_000;
  Date.now() < until && s.exit === undefined;
  await sleep(500)
) {
  if (/\/login|Login reached/.test(s.text())) break;
  if (waiters().length > 0) {
    watching = true;
    break;
  }
}
s.snap("when the wait was looked for");
console.log("a `kodel wait` process runs:", watching, JSON.stringify(waiters()));
if (!watching) {
  await quit(s);
  console.log(
    "the session never started `kodel wait` (not signed in, or it did something else): criterion 5 not answered",
  );
  process.exit(2);
}
// For the process group rule of step 2: where a background command of the agent lives.
console.log(
  "pid ppid pgid tty of the waiter:",
  sh("sh", [
    "-c",
    `ps -A -o pid=,ppid=,pgid=,tty=,command= | grep "wait ${runId}" | grep -v grep | cut -c1-110`,
  ]).trim(),
);
console.log("the agent's pid (= its group):", s.pid);

await s.quiet(5000, 60_000); // its turn ended
const linesBefore = text().split("\n").length;
const bytesBefore = s.bytes;
console.log(`idle for ${delayS} s from ${new Date().toISOString()}`);
await sleep(delayS * 1000);
console.log(
  `while idle: ${s.bytes - bytesBefore} bytes written to the terminal; the waiter still runs: ${waiters().length > 0}`,
);

const decided = sh("bun", [
  path.join(import.meta.dirname, "decide.ts"),
  p.root,
  p.state,
  runId,
  "approve",
  "approved",
]);
console.log("decided at", new Date().toISOString(), decided.trim());
let woke = false;
for (
  const until = Date.now() + 120_000;
  Date.now() < until && s.exit === undefined;
  await sleep(500)
) {
  const fresh = text().split("\n").slice(linesBefore).join("\n");
  if (/pipeline_next_step/.test(fresh)) {
    woke = true;
    break;
  }
}
await s.quiet(4000, 60_000);
s.snap("after the decision");
console.log(
  `the session went on by itself after the decision (called pipeline_next_step, no key typed): ${woke ? "YES" : "NO"}`,
);
console.log(
  sh("node", [ARTIFACT, "--root", p.root, "status", runId], {
    env: { ...agentEnv(), KODEL_STATE_DIR: p.state },
  }).slice(0, 400),
);
await quit(s);
