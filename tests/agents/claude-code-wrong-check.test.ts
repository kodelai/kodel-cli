import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTurn,
  callsTo,
  describeCalls,
  ENABLED,
  journalEvents,
  makeSandbox,
  runAgentTurn,
  type Sandbox,
} from "./harness";

/**
 * A check that can never pass although the work is right: does the agent offer the person to record
 * `wrong_check` with the check's id, and write nothing before the person agrees; and once they agree,
 * does it name the check of that step. The person's side is played by the next prompt.
 */

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const s of sandboxes.splice(0)) s.cleanup();
});

const TOOLS = ["mcp__kodel", "Read", "Write", "Edit", "Glob", "Grep"];
const scenario = ENABLED ? test : test.skip;
const explain = (turn: AgentTurn) => `\n${describeCalls(turn)}\n${turn.finalText}`;

// The second check asks for a file the step says not to create, so it fires for nothing.
const PIPELINE = [
  "name: wrongcheck",
  "description: Create hello.txt; a second check can never pass.",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: |",
  "      Task: {{task}}",
  "      Create the file hello.txt in the repository root containing exactly the word hello.",
  "      Change nothing else. Do not create any other file.",
  "    checks:",
  '      - { kind: diff, paths: ["hello.txt"], mode: changed_only }',
  '      - { kind: diff, paths: ["never.txt"], mode: changed_only }',
  "",
].join("\n");

const runIds = (sandbox: Sandbox) => readdirSync(join(sandbox.dir, ".kodel", "runs"));

describe("Claude Code, with a check that fires for nothing", () => {
  scenario(
    "it offers to record wrong_check, writes nothing before the person agrees, then names the check",
    async () => {
      const sandbox = makeSandbox({ fixture: { pipeline: PIPELINE } });
      sandboxes.push(sandbox);

      const first = await runAgentTurn({
        sandbox,
        prompt:
          "Use the wrongcheck pipeline to create hello.txt exactly as the step says. If a check " +
          "fails although you did what the step says, do not work around it: tell me which check " +
          "it is, and wait for me.",
        allowedTools: TOOLS,
      });
      const why1 = explain(first);
      expect(callsTo(first, "pipeline_start").length, `it never started${why1}`).toBe(1);
      expect(
        callsTo(first, "pipeline_feedback"),
        `it wrote feedback before the person agreed${why1}`,
      ).toEqual([]);
      const run = runIds(sandbox)[0] as string;
      expect(journalEvents(sandbox, run), why1).not.toContain("feedback_reported");
      expect(first.finalText, `it did not name the check${why1}`).toContain("write/diff#2");

      const second = await runAgentTurn({
        sandbox,
        resume: first.sessionId,
        prompt: "Yes, record it as a wrong check.",
        allowedTools: TOOLS,
      });
      const why2 = explain(second);
      const sent = callsTo(second, "pipeline_feedback");
      expect(sent.length, `it did not record it${why2}`).toBeGreaterThanOrEqual(1);
      expect(sent[0]?.input, why2).toMatchObject({
        category: "wrong_check",
        check: "write/diff#2",
      });
      expect(journalEvents(sandbox, run), why2).toContain("feedback_reported");
    },
  );
});
