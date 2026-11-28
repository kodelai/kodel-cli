import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  type AgentTurn,
  agentEnv,
  callsTo,
  describeCalls,
  ENABLED,
  humanHost,
  MAIN_TS,
  makeSandbox,
  runAgentTurn,
  type Sandbox,
  TURN_TIMEOUT_MS,
} from "./harness";
import { allTasks, seedTasks, TASKS_ON } from "./tasks-harness";

/**
 * A manager starts a task and stops its agent (`manager_start_task`, `manager_stop_agent`) with the real
 * `claude`. The rule tests prove what each tool answers; what only a real agent shows is that a manager that is
 * told by the person to start a task and then to stop its agent finds both tools, calls them with the right
 * arguments, and leaves the run as the tools promise: open, tied to its task, with an agent that is stopped.
 *
 * There is no daemon in this scenario (its not starting a stopped agent is the unit tests' job) and the person
 * never decides the gate. The started worker is `claude -p` (`worker: print`), since the server runs under Bun,
 * where no terminal session can be opened. Runs outside the sandbox only (`KODEL_AGENT_TESTS=1`): it needs
 * `claude` signed in, the process table and the API.
 */

const scenario = ENABLED ? test : test.skip;

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const s of sandboxes.splice(0)) s.cleanup();
});

const explain = (turn: AgentTurn) => `\n${describeCalls(turn)}\n${turn.finalText}`;

const KEYS_ON = "decisions:\n  agent:\n    start_task: true\n    stop_agent: true\n";
const PRINT_WORKER = "engines:\n  claude:\n    worker: print\n";

describe("manager_start_task and manager_stop_agent with a real agent", () => {
  scenario(
    "manager_starts_and_stops",
    async () => {
      const sandbox = makeSandbox({
        worktree: true,
        config: `${TASKS_ON}${KEYS_ON}${PRINT_WORKER}`,
      });
      sandboxes.push(sandbox);
      const [key] = await seedTasks(sandbox, [
        { title: "Say hello", body: "Create hello.txt, as the steps say." },
      ]);
      if (key === undefined) throw new Error("no task");

      const turn = await runAgentTurn({
        sandbox,
        prompt:
          `I ask you to start the task ${key} with the pipeline "mini" in a background agent. ` +
          "When it is started, I ask you to stop the agent of that run right away. " +
          "Do not cancel or change anything else, and tell me what you did.",
        allowedTools: ["mcp__kodel"],
        mcpArgs: ["--role", "manager"],
      });

      // Both tools were offered and called, and neither call failed.
      const offered = turn.kodelTools.map((t) => t.replace("mcp__kodel__", ""));
      expect(offered, explain(turn)).toContain("manager_start_task");
      expect(offered, explain(turn)).toContain("manager_stop_agent");
      const starts = callsTo(turn, "manager_start_task");
      expect(starts.length, explain(turn)).toBeGreaterThan(0);
      const started = starts.find((c) => !c.isError && /"started":\s*true/.test(c.output));
      expect(started, explain(turn)).toBeDefined();
      expect(started?.input.key, explain(turn)).toBe(key);
      // `force` is for a person who said so: this one did not.
      expect(
        starts.filter((c) => c.input.force === true),
        explain(turn),
      ).toEqual([]);
      const stops = callsTo(turn, "manager_stop_agent");
      expect(stops.length, explain(turn)).toBeGreaterThan(0);
      const stopped = stops.find((c) => !c.isError && /"stopped":\s*true/.test(c.output));
      expect(stopped, explain(turn)).toBeDefined();

      // The run is tied to the task and is still open: a stop does not cancel it.
      const task = (await allTasks(sandbox)).find((t) => t.key === key);
      const runId = task?.runs[0];
      expect(runId, explain(turn)).toBeDefined();
      if (runId === undefined) return;
      expect(stopped?.input.run_id, explain(turn)).toBe(runId);
      const state = await (await humanHost(sandbox).open(runId))?.state();
      expect(state?.status, explain(turn)).toBe("running");

      // `kodel agent ls` says the agent of the run is stopped (by a manager).
      const listed = spawnSync(process.execPath, [MAIN_TS, "--root", sandbox.dir, "agent", "ls"], {
        cwd: sandbox.dir,
        env: agentEnv(sandbox.stateDir) as NodeJS.ProcessEnv,
        encoding: "utf8",
      });
      const line = `${listed.stdout}`.split("\n").find((l) => l.includes(`kw-${runId}`));
      expect(line, `${listed.stdout}${listed.stderr}${explain(turn)}`).toBeDefined();
      expect(line, explain(turn)).toContain("stopped");
    },
    2 * TURN_TIMEOUT_MS + 120_000,
  );
});
