import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  type AgentTurn,
  callsTo,
  describeCalls,
  ENABLED,
  humanHost,
  journalEvents,
  MINI_PIPELINE,
  makeSandbox,
  runAgentTurn,
  type Sandbox,
  TURN_TIMEOUT_MS,
} from "./harness";

/**
 * `kodel wait` with a real agent: at a gate the server's text offers a command that only watches. Does
 * the agent start it in the background, end its turn, and is it woken by the person's decision, with
 * no polling in between; and when the command gives up, does it leave it at that.
 *
 * What a first look with the real `claude` found, and why the scenarios are shaped like this:
 *
 * - `claude -p` does not end with the agent's turn: the process stays until its background tasks
 *   have ended, and a task that ends wakes the agent for one more turn in the same process. So the
 *   wake can be tested in one call, with the person's decision made from here while the agent is
 *   "away".
 * - Both the Bash tool with `run_in_background` and the Monitor tool wake it. Monitor stops after at
 *   most 30 minutes and wakes the agent then ("re-arm"), so the text sends Claude Code to Bash.
 *
 * The person's side is played by the test, through the same calls the CLI commands make.
 */

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const s of sandboxes.splice(0)) s.cleanup();
});

const TOOLS = [
  "mcp__kodel",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  // Not only `Bash(kodel wait:*)`: an agent whose first Bash call (writing the file) is refused
  // takes Bash for forbidden and never tries the command we are asking about. What it runs that only
  // a person may is checked by `forbidden` below.
  "Bash",
  "Monitor",
];
const scenario = ENABLED ? test : test.skip;

const PROMPT = "Use the mini pipeline to create hello.txt exactly as the step says.";

const explain = (turn: AgentTurn) => `\n${describeCalls(turn)}\n${turn.finalText}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Calls in which the agent starts `kodel wait`, through the Bash tool or the Monitor tool. */
const waitCalls = (turn: AgentTurn) =>
  turn.calls.filter(
    (c) =>
      (c.name === "Bash" || c.name === "Monitor") &&
      String(c.input.command ?? "").includes("kodel wait"),
  );

/** What the agent ran that only a person may: a decision, or a look into the run's files. */
const forbidden = (turn: AgentTurn) =>
  turn.calls.filter((c) => {
    const text = String(c.input.command ?? c.input.file_path ?? "");
    return /kodel (gate|resume|ack|seal)\b/.test(text) || text.includes(".kodel/runs");
  });

/** The id of the only run, once it is waiting at its human step. */
async function waitForGate(sandbox: Sandbox, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await humanHost(sandbox).runSummaries();
    const at = runs.find((r) => r.state?.active.some((v) => v.phase === "human"));
    if (at) return at.meta.runId;
    await sleep(500);
  }
  throw new Error("the run never reached its human step");
}

/** Whether a `kodel wait <run>` process is running now (the agent started it). */
function waitIsRunning(runId: string): boolean {
  try {
    execFileSync("pgrep", ["-f", `main.ts .* wait ${runId}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function waitUntilWatching(runId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (waitIsRunning(runId)) return true;
    await sleep(500);
  }
  return false;
}

describe("Claude Code, when the run waits for a person", () => {
  scenario(
    "it starts kodel wait in the background, ends its turn, and is woken by the decision",
    async () => {
      const sandbox = makeSandbox({ fixture: { pipeline: MINI_PIPELINE } });
      sandboxes.push(sandbox);
      const agent = runAgentTurn({ sandbox, prompt: PROMPT, allowedTools: TOOLS });

      const runId = await waitForGate(sandbox, TURN_TIMEOUT_MS);
      const watching = await waitUntilWatching(runId, 120_000);
      // Let it end its turn: what wakes it later is the decision and nothing else.
      await sleep(5_000);
      const run = await humanHost(sandbox).open(runId);
      expect((await run?.decideHuman("approve", "approved"))?.ok).toBe(true);
      await run?.waitForRest(60_000);
      const turn = await agent;
      const why = explain(turn);

      expect(watching, `it never started kodel wait${why}`).toBe(true);
      const started = waitCalls(turn);
      expect(started.length, `it did not start kodel wait once${why}`).toBe(1);
      expect(String(started[0]?.input.command), why).toContain(`kodel wait ${runId}`);
      if (started[0]?.name === "Bash") {
        expect(started[0].input.run_in_background, `it waited in the foreground${why}`).toBe(true);
      }
      expect(turn.transcript, `it did not tell the person how to decide${why}`).toMatch(
        /kodel gate (approve|reject)/,
      );
      expect(forbidden(turn), `it did what only a person may${why}`).toEqual([]);
      // No polling: the start, the one after the step was done, and the one after the wake.
      expect(
        callsTo(turn, "pipeline_next_step").length,
        `it polled pipeline_next_step${why}`,
      ).toBeLessThanOrEqual(4);
      // It was woken and went on by itself.
      const state = await (await humanHost(sandbox).open(runId))?.state();
      expect(journalEvents(sandbox, runId)).toContain("gate_decided");
      const afterWake = callsTo(turn, "pipeline_next_step").at(-1)?.output ?? "";
      expect(afterWake, `it did not ask what is next after the decision${why}`).toMatch(
        /done|completed|running/,
      );
      expect(state?.status, why).toBe("completed");
    },
    TURN_TIMEOUT_MS * 3,
  );

  scenario(
    "when kodel wait gives up it tells the person and does not start it again",
    async () => {
      const sandbox = makeSandbox({ fixture: { pipeline: MINI_PIPELINE } });
      sandboxes.push(sandbox);
      const turn = await runAgentTurn({
        sandbox,
        prompt: PROMPT,
        allowedTools: TOOLS,
        // The shim gives `kodel wait` a timeout of a few seconds; nobody decides.
        env: { KODEL_TEST_WAIT_TIMEOUT: "6" },
      });
      const why = explain(turn);
      expect(waitCalls(turn).length, `it did not start kodel wait exactly once${why}`).toBe(1);
      // The words are the agent's own, in the person's language: what is checked is that it did not
      // start the command again (above), did not decide, and still told the person how to.
      expect(turn.finalText, `it did not tell the person how to decide${why}`).toMatch(
        /kodel gate (approve|reject)/,
      );
      expect(forbidden(turn), `it did what only a person may${why}`).toEqual([]);
      const runs = await humanHost(sandbox).runSummaries();
      expect(journalEvents(sandbox, runs[0]?.meta.runId ?? ""), why).not.toContain("gate_decided");
    },
    TURN_TIMEOUT_MS * 2,
  );
});
