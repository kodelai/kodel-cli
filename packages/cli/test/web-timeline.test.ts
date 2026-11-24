/** The agent's log on a run's screen (T-44) is cut into the steps of the run by the time each step went on. */
import { expect, test } from "bun:test";
import { demoRunningDetail } from "../src/tui/demo";
import { groupsOf, noticeOf } from "../src/web/app/groups";

test("t44_agent_log_is_cut_by_step", () => {
  const d = demoRunningDetail("r_1kd9q22vb", Date.now());
  if (!d) throw new Error("no sample run");
  const groups = groupsOf(d);
  // Every entry lands in exactly one step, in the order of the log.
  expect(groups.flatMap((g) => g.entries)).toEqual(d.agentLog ?? []);
  // A step at work is shown even before the agent says anything in it.
  expect(groups.at(-1)?.visit?.state).toBe("running");
  for (const g of groups) {
    const from = g.visit?.attempt.from;
    const to = g.visit?.attempt.to ?? Number.POSITIVE_INFINITY;
    if (from === undefined) continue;
    for (const e of g.entries) expect(e.ts >= from && e.ts <= to).toBe(true);
  }
});

test("t44_lines_claude_code_writes_are_not_the_persons_words", () => {
  const done = noticeOf(
    '<task-notification> <task-id>af725</task-id> <status>completed</status> <summary>Agent "Plan critique 2: invariants" finished</summary> <result>This agent\'s repo…',
  );
  expect(done).toEqual({
    kind: "task",
    title: "Plan critique 2: invariants",
    status: "completed",
    result: "This agent's repo…",
  });
  expect(noticeOf("<system-reminder>be brief</system-reminder>")).toMatchObject({
    kind: "notice",
    tag: "system-reminder",
  });
  expect(noticeOf("<local-command-stdout>ok</local-command-stdout>")?.kind).toBe("notice");
  // The person's own words, even with a tag in them, stay theirs.
  expect(noticeOf("Fix the <div> in the header")).toBeUndefined();
  expect(noticeOf("<b>bold</b> please")).toBeUndefined();
});
