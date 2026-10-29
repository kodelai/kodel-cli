// A run with a fork on a built kodel (T-40): two command branches that run at the same time, both
// failing once, a join told of both failures (the state is written and read back between the entry
// of the join and the answer) that restarts the failed branches, and the commands `status` and
// `report` opening the run afterwards. Used by check-artifact.mjs against the artifact and by the e2e
// test against the build it makes; the commands of the pipeline are valid in a POSIX shell and in
// cmd.exe alike (`node -e` with double quotes, no shell operators).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FORK_PIPELINE = [
  "name: fork",
  "nodes:",
  "  - slug: impl",
  "    kind: agent",
  "    prompt: make the change",
  "  - slug: verify",
  "    kind: command",
  // the long branch: fails the first time and leaves a marker, passes the second time
  `    command: node -e "const fs=require('fs');const first=!fs.existsSync('.verify-ran');if(first)fs.writeFileSync('.verify-ran','');setTimeout(() => process.exit(Number(first)), 600)"`,
  "  - slug: test",
  "    kind: command",
  // the short branch: fails the first time and leaves a marker, passes the second time
  `    command: node -e "const fs=require('fs');if(!fs.existsSync('.test-ran')){fs.writeFileSync('.test-ran','');process.exit(1)}"`,
  "  - slug: fix",
  "    kind: agent",
  "    join: all",
  "    prompt: fix what failed, or finish",
  "edges:",
  "  - { from: impl, to: verify }",
  "  - { from: impl, to: test }",
  "  - { from: verify, to: fix }",
  "  - { from: verify, to: fix, when: failed }",
  "  - { from: test, to: fix }",
  "  - { from: test, to: fix, when: failed }",
  "",
].join("\n");

/** The commands of the pipeline: each one `node -e "..."`, nothing a shell would read. */
export function commandsValidInCmd(pipeline = FORK_PIPELINE) {
  const commands = [...pipeline.matchAll(/^\s+command: (.*)$/gm)].map((m) => m[1]);
  return (
    commands.length > 0 &&
    // no `&&`, `||`, a pipe, a redirection (an arrow `=>` is JavaScript, not a redirection) or a backtick
    commands.every((c) => /^node -e "[^"]*"$/.test(c) && !/&&|\|\||\s\|\s|(^|[^=])>|<|`/.test(c))
  );
}

/**
 * Drives the fork on the artifact and returns what it saw; `fail(message)` is called (and expected
 * to throw or exit) when something is not as it should be. `Client` and `StdioClientTransport` are
 * the MCP SDK's, given by the caller so this file resolves nothing itself.
 */
export async function checkForkRun(artifact, { Client, StdioClientTransport, fail }) {
  const dir = mkdtempSync(join(tmpdir(), "kodel-artifact-fork-"));
  // The trusted hashes of the run go into the scratch folder too, not into the home of whoever runs this.
  const env = { ...process.env, KODEL_STATE_DIR: join(dir, "state") };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [artifact, "--root", dir, "mcp"],
    cwd: dir,
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "check-artifact", version: "0" });
  try {
    mkdirSync(join(dir, ".kodel", "pipelines"), { recursive: true });
    writeFileSync(
      join(dir, ".kodel", "config.yaml"),
      "version: 1\nworktree: { mode: off }\nhistory: { changes: { enabled: false } }\n",
    );
    writeFileSync(join(dir, ".kodel", "pipelines", "fork.yaml"), FORK_PIPELINE);
    await client.connect(transport);
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse(result.content[0].text);
    };
    const started = await call("pipeline_start", {
      task: "verify and test at once",
      pipeline: "fork",
      cwd: dir,
      title: "fork-run",
    });
    if (!started.run_id) fail(`the fork run did not start: ${JSON.stringify(started)}`);
    const runId = started.run_id;
    const untilStep = async (slug, attempt) => {
      for (let i = 0; i < 60; i += 1) {
        const next = await call("pipeline_next_step", { run_id: runId, wait_s: 2 });
        if (next.node?.slug === slug && next.node.attempt === attempt) return next;
        if (next.done) fail(`the run ended before "${slug}" #${attempt}: ${JSON.stringify(next)}`);
      }
      fail(`the run did not reach "${slug}" #${attempt}`);
    };
    const complete = async (slug, attempt, outcome) => {
      const done = await call("pipeline_complete_step", {
        run_id: runId,
        node_slug: slug,
        attempt,
        ...(outcome === undefined ? {} : { outcome }),
      });
      if (done.ok === false) fail(`${slug} #${attempt} was refused: ${JSON.stringify(done)}`);
      return done;
    };
    await untilStep("impl", 1);
    await complete("impl", 1);
    const joined = await untilStep("fix", 1);
    // Both failures, through the real host: the state was written and read back since the join was
    // entered, so the text must not depend on what was one object in memory.
    const joinFeedback = String(joined.node.reentry_feedback ?? "");
    if (!joinFeedback.startsWith("Branches of the fork failed:")) {
      fail(`the join was not told that branches failed: ${JSON.stringify(joined.node)}`);
    }
    for (const branch of ["verify", "test"]) {
      if (!joinFeedback.includes(`"${branch}" failed`)) {
        fail(`the join was not told that "${branch}" failed: ${joinFeedback}`);
      }
    }
    if (!(joined.node.outcomes ?? []).includes("restart_failed")) {
      fail(`the join does not offer restart_failed: ${JSON.stringify(joined.node.outcomes)}`);
    }
    await complete("fix", 1, "restart_failed");
    await untilStep("fix", 2);
    const last = await complete("fix", 2);
    if (!last.next?.done || last.next.run_status !== "completed") {
      fail(`the fork run did not complete: ${JSON.stringify(last.next)}`);
    }
    const journal = readFileSync(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const events = journal.map((r) => r.event);
    for (const event of ["fork_started", "branch_settled", "join_reached", "run_finished"]) {
      if (!events.includes(event)) fail(`the journal of the fork run has no ${event}`);
    }
    const entered = (node) =>
      journal.findIndex((r) => r.event === "node_entered" && r.node === node);
    const finished = (node) =>
      journal.findIndex((r) => r.event === "node_finished" && r.node === node);
    if (!(entered("verify") < finished("test") && entered("test") < finished("verify"))) {
      fail("the branches of the fork did not run at the same time");
    }
    const reached = journal.find((r) => r.event === "join_reached");
    if (JSON.stringify(reached?.failed) !== JSON.stringify(["verify", "test"])) {
      fail(`the first join_reached does not name the failed branches: ${JSON.stringify(reached)}`);
    }
    if (journal.filter((r) => r.event === "join_reached").length !== 2) {
      fail("restart_failed did not bring the join a second time");
    }
    // the commands a person uses open the run: status and the report with the fork's numbers
    const cli = (...args) =>
      execFileSync(process.execPath, [artifact, "--root", dir, ...args], {
        encoding: "utf8",
        cwd: dir,
        env,
      });
    const status = cli("status", runId);
    // the failed branches were run again and passed: the run does not stand on a failed branch
    if (!status.includes("status:    completed\n") || status.includes("failed branches")) {
      fail(`status does not show a run completed after its failed branches were redone: ${status}`);
    }
    if (!status.includes("trail:     impl > verify > test > fix > verify > test > fix")) {
      fail(`status does not show the trail of the fork: ${status}`);
    }
    const report = JSON.parse(cli("report", runId, "--json"));
    if (report.failed_branches !== false || report.forks?.[0]?.failed?.length !== 0) {
      fail(`the report flags a failed branch that was redone: ${JSON.stringify(report.forks)}`);
    }
    for (const branch of ["verify", "test"]) {
      if (report.nodes?.find((n) => n.node === branch)?.attempts?.length !== 2) {
        fail(`the report does not show the two attempts of the redone branch "${branch}"`);
      }
    }
    if (report.critical_path?.length !== 1 || report.critical_path[0].fork !== "f1") {
      fail(`the report has no critical path for the fork: ${JSON.stringify(report.critical_path)}`);
    }
    // both are summed in milliseconds and rounded once (report.ts), and the union of the attempts'
    // intervals is never longer than their sum, so the wall time never reads above the work time
    if (typeof report.busy_wall_s !== "number" || report.busy_wall_s > report.work_s) {
      fail(`busy_wall_s is not a bounded number: ${report.busy_wall_s} vs work ${report.work_s}`);
    }
    if (report.forks?.[0]?.overlaps?.length !== 1) {
      fail(`the report does not see the overlap: ${JSON.stringify(report.forks)}`);
    }
    return { runId, events, journal, report, status, joinFeedback };
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
