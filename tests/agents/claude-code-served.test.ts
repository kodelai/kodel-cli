import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeCalls,
  ENABLED,
  humanHost,
  journalRecords,
  makeSandbox,
  runAgentTurn,
  type Sandbox,
  servedFiles,
} from "./harness";

/**
 * What the agent was shown, and who it was, on a real Claude Code: one headless turn in a throwaway
 * Kodel project, then the run's files. The two tests read the same run, so a real agent is paid for
 * once. The assertions are on files and on the journal, never on what the agent said. They only run
 * with KODEL_AGENT_TESTS=1 (`bun run test:agents`); a person runs them, the pipeline cannot.
 */
const scenario = ENABLED ? test : test.skip;

let sandbox: Sandbox | undefined;
let shared: Promise<{ runId: string; sandbox: Sandbox; why: string }> | undefined;
afterAll(() => sandbox?.cleanup());

/** The run of one real turn, made on the first use. */
function theRun() {
  shared ??= (async () => {
    sandbox = makeSandbox();
    const turn = await runAgentTurn({
      sandbox,
      prompt: "Please create hello.txt for me using the mini pipeline.",
      allowedTools: ["mcp__kodel", "Read", "Write", "Edit", "Glob", "Grep"],
    });
    const why = `\n${describeCalls(turn)}\n${turn.finalText}`;
    const runs = await humanHost(sandbox).runSummaries();
    expect(runs.length, `the agent did not start exactly one run${why}`).toBe(1);
    return { runId: runs[0]?.meta.runId as string, sandbox, why };
  })();
  return shared;
}

describe("Claude Code, what it was shown and who it was", () => {
  scenario(
    "claude_code_v75e_served_files",
    async () => {
      const { runId, sandbox, why } = await theRun();
      const run = await humanHost(sandbox).open(runId);
      const state = await run?.state();
      const attempts = state?.nodes["write"]?.attempt ?? 0;
      expect(attempts, `the agent never did the step${why}`).toBeGreaterThanOrEqual(1);

      const records = journalRecords(sandbox, runId);
      const served = records.filter((r) => r.event === "step_served");
      const files = servedFiles(sandbox, runId);
      // every attempt of the step the agent did has a file and an event, and a repeated
      // `pipeline_next_step` of the agent made no second file (one client, one session)
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const events = served.filter((r) => r.node === "write" && r.attempt === attempt);
        expect(events.length, `attempt ${attempt} has no step_served event${why}`).toBe(1);
        const ref = String(events[0]?.ref);
        expect(files, `attempt ${attempt} has no served file${why}`).toContain(
          ref.replace("served/", ""),
        );
        const file = JSON.parse(
          readFileSync(join(sandbox.dir, ".kodel", "runs", runId, ref), "utf8"),
        );
        expect(file).toMatchObject({ v: 1, node: "write", attempt });
        expect(file.prompt_hash).toBe(events[0]?.prompt_hash);
        expect(file.answer.prompt).toContain("hello.txt");
      }
      expect(files.length, `a repeat made another file${why}`).toBe(served.length);
    },
    600_000,
  );

  scenario(
    "claude_code_5btp_executor_record",
    async () => {
      const { runId, sandbox, why } = await theRun();
      const records = journalRecords(sandbox, runId);
      type Executor = {
        client?: { value: { name: string; version: string }; source: string };
        session?: { value: string; source: string };
      };
      const started = records.find((r) => r.event === "run_started")?.executor as
        | Executor
        | undefined;
      const completed = records.filter((r) => r.event === "agent_completed");
      expect(completed.length, `the agent completed no step${why}`).toBeGreaterThan(0);

      for (const [where, executor] of [
        ["run_started", started],
        ...completed.map((r) => ["agent_completed", r.executor as Executor | undefined] as const),
      ] as const) {
        expect(executor?.client, `${where} has no client${why}`).toBeDefined();
        expect(executor?.client?.source).toBe("observed");
        expect(executor?.client?.value.name, `${where}: the client has no name`).not.toBe("");
        expect(
          executor?.client?.value.version,
          `${where}: Claude Code reported no client version in the handshake (name: ${executor?.client?.value.name}); the record would be incomplete`,
        ).not.toBe("");
        // the session comes from the environment of the server or from the hook index; if neither
        // is there on this version of Claude Code, install the hooks in the sandbox (`kodel init`)
        expect(
          executor?.session,
          `${where} has no session: Claude Code did not export CLAUDE_CODE_SESSION_ID to the server and no hook registered one${why}`,
        ).toBeDefined();
        expect(["observed-env", "observed-hook"]).toContain(executor?.session?.source as string);
        expect(executor?.session?.value).not.toBe("");
      }
      // the session of the start is the session of the steps: one agent, one turn
      const sessions = new Set(
        [started, ...completed.map((r) => r.executor as Executor | undefined)].map(
          (e) => e?.session?.value,
        ),
      );
      expect(sessions.size, `more than one session in one turn${why}`).toBe(1);
    },
    600_000,
  );
});
