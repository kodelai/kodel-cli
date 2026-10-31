import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { FileStore, readStoredAgentLog } from "../../packages/local/src";
import { claudeConfigDir, projectFolderName } from "../../packages/local/src/history";
import {
  describeCalls,
  ENABLED,
  humanHost,
  journalRecords,
  makeSandbox,
  runAgentTurn,
  type Sandbox,
} from "./harness";

/**
 * The agent's conversation log kept in a run, on a real Claude Code: one headless turn in a throwaway Kodel
 * project, then the run's files. The assertions are on files and on the journal, never on what the agent said. They
 * only run with KODEL_AGENT_TESTS=1 (`bun run test:agents`); a person runs them before the change is merged, with the
 * Claude Code version noted in the pull request. They are not in CI.
 *
 * What they are the only evidence for:
 *  - the server of the agent has the session in its environment (`observed-env`); without it nothing would be
 *    stored on a machine where the hooks are not connected;
 *  - the run's id is in the agent's own log, so a session is recognised as the run's;
 *  - the copy is made while the step goes (the timer) and at its end, before the run ends;
 *  - a secret in a tool input is not in the stored events, and the raw log is not copied.
 *
 * `/clear` cannot be tried here (the headless turn has no such command): the person tries it once by hand, as the plan
 * says, and the rule is pinned with fake logs in `packages/local/test`.
 */
const scenario = ENABLED ? test : test.skip;
const CANARY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

let sandbox: Sandbox | undefined;
let shared: Promise<{ runId: string; sandbox: Sandbox; why: string }> | undefined;
afterAll(() => sandbox?.cleanup());

/** The run of one real turn, made on the first use. */
function theRun() {
  shared ??= (async () => {
    // a copy every second: the step of a real agent takes long enough for the timer to go more than once
    sandbox = makeSandbox({ config: "history:\n  agent_log:\n    interval_s: 1\n" });
    const turn = await runAgentTurn({
      sandbox,
      prompt:
        "Please create hello.txt for me using the mini pipeline. Before you write it, run the shell command " +
        `\`echo key=${CANARY}\` once with the Bash tool.`,
      allowedTools: ["mcp__kodel", "Read", "Write", "Edit", "Glob", "Grep", "Bash(echo:*)"],
    });
    const why = `\n${describeCalls(turn)}\n${turn.finalText}`;
    const runs = await humanHost(sandbox).runSummaries();
    expect(runs.length, `the agent did not start exactly one run${why}`).toBe(1);
    return { runId: runs[0]?.meta.runId as string, sandbox, why };
  })();
  return shared;
}

describe("Claude Code, the agent's log kept in a run", () => {
  scenario(
    "claude_code_3bk2_the_copy_is_made_while_the_step_goes_and_at_its_end",
    async () => {
      const { runId, sandbox, why } = await theRun();
      const records = journalRecords(sandbox, runId);
      const copies = records.filter((r) => r.event === "agent_log_saved");
      expect(copies.length, `the run kept none of the agent's log${why}`).toBeGreaterThan(0);
      expect(
        copies.some((r) => r.why === "step"),
        `no copy was made at the end of a step${why}`,
      ).toBe(true);
      // the timer went too: at least two copies for one step of a real agent
      expect(copies.length, `only one copy: the timer never went${why}`).toBeGreaterThanOrEqual(2);
      const finished = records.findIndex((r) => r.event === "run_finished");
      if (finished >= 0) {
        const lastCopy = records.map((r) => r.event).lastIndexOf("agent_log_saved");
        expect(lastCopy, "a copy was journaled after the run had ended").toBeLessThan(finished);
      }
      const failed = records.filter((r) => r.event === "agent_log_failed").map((r) => r.reason);
      expect(failed, `the copy gave up${why}`).toEqual([]);
    },
    600_000,
  );

  scenario(
    "claude_code_3bk2_the_session_is_the_one_in_the_environment_and_has_the_run_id",
    async () => {
      const { runId, sandbox, why } = await theRun();
      const records = journalRecords(sandbox, runId);
      const started = records.find((r) => r.event === "run_started")?.executor as
        | { session?: { value: string; source: string } }
        | undefined;
      expect(
        started?.session?.source,
        `Claude Code did not export CLAUDE_CODE_SESSION_ID to the server (Decision 4 of the plan has to be reopened)${why}`,
      ).toBe("observed-env");
      const session = started?.session?.value as string;
      const run = await humanHost(sandbox).open(runId);
      const state = await run?.state();
      expect(Object.keys(state?.agentLog?.sessions ?? {}), why).toContain(session);
      const kept = state?.agentLog?.sessions[session];
      const read = await readStoredAgentLog(
        new FileStore({ root: join(sandbox.dir, ".kodel") }),
        runId,
        session,
        kept?.length ?? 0,
      );
      expect(read.ok, JSON.stringify(read)).toBe(true);
      // the window starts at the first call of the run's tools
      const first = read.events.find((e) => e.kind === "tool_call");
      expect(first, `no tool call in the copy${why}`).toBeDefined();
      expect(first?.kind === "tool_call" && first.name, why).toMatch(
        /pipeline_(start|next_step|complete_step)$/,
      );
      // what came before it (the person's request) is outside
      const texts = read.events.flatMap((e) =>
        e.kind === "message" && e.role === "user" ? [e.text_preview ?? ""] : [],
      );
      expect(
        texts.some((t) => t.includes("Please create hello.txt")),
        why,
      ).toBe(false);
    },
    600_000,
  );

  scenario(
    "claude_code_3bk2_a_secret_is_redacted_and_the_raw_log_is_not_copied",
    async () => {
      const { runId, sandbox, why } = await theRun();
      const records = journalRecords(sandbox, runId);
      const started = records.find((r) => r.event === "run_started")?.executor as
        | { session?: { value: string } }
        | undefined;
      const session = started?.session?.value as string;
      const raw = readFileSync(
        // the agent's folder is named after the real directory (macOS: /private/var, not the /var the sandbox has)
        join(
          claudeConfigDir(),
          "projects",
          projectFolderName(realpathSync(sandbox.dir)),
          `${session}.jsonl`,
        ),
        "utf8",
      );
      // the canary did reach the agent's own log: the test means something
      expect(raw, `the agent never ran the command with the canary${why}`).toContain(CANARY);
      const file = readFileSync(
        join(sandbox.dir, ".kodel", "runs", runId, "agent_log", `${session}.jsonl`),
        "utf8",
      );
      expect(file).not.toContain(CANARY);
      // a raw line of the agent's log has fields of its own; none of them is in the copy
      expect(file).not.toContain("parentUuid");
      expect(file).not.toContain("isSidechain");
      for (const line of file.split("\n").filter(Boolean)) {
        expect(JSON.parse(line)).toMatchObject({ v: 1, agent: "claude-code" });
      }
    },
    600_000,
  );
});
