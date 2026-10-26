import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  decide,
  defaultHistory,
  MAX_SERVED_EVENTS,
  MAX_SERVED_PER_ATTEMPT,
  parsePipeline,
  type RunEvent,
  type RunState,
  summarizeRun,
} from "../src";

const spec = parsePipeline(
  [
    "name: p",
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    "    prompt: write",
    "  - slug: approve",
    "    kind: human",
    "    prompt: ok?",
    "edges:",
    "  - { from: write, to: approve }",
    "  - { from: approve, to: write, when: rejected }",
    "",
  ].join("\n"),
);

function apply(state: RunState | undefined, event: RunEvent) {
  const result = decide(spec, state, event, 0);
  if (!result.ok) throw result.error;
  return result;
}

const started = (prompts = true) => {
  const history = defaultHistory();
  history.prompts.enabled = prompts;
  return apply(undefined, { type: "start", runId: "r", task: "t", specHash: "h", history }).state;
};

const served = (key: string, attempt = 1, node = "write"): RunEvent => ({
  type: "step_served",
  node,
  attempt,
  key,
  promptHash: "f".repeat(64),
});

describe("the record of what the agent was shown", () => {
  test("v75e_machine_numbers_the_answers_and_names_the_file", () => {
    let result = apply(started(), served("k1"));
    expect(result.journal).toMatchObject([
      { event: "step_served", node: "write", attempt: 1, n: 1, ref: "served/write-1-1.json" },
    ]);
    result = apply(result.state, served("k2"));
    expect(result.journal[0]).toMatchObject({ n: 2, ref: "served/write-1-2.json" });
    expect(result.state.served).toEqual({ "write:1": ["k1", "k2"] });
  });

  test("v75e_a_seen_key_is_a_repeat", () => {
    const first = apply(started(), served("k1")).state;
    const again = apply(first, served("k1"));
    expect(again).toMatchObject({ noop: true, journal: [] });
  });

  test("v75e_run_without_the_record_ignores_the_event", () => {
    const state = started(false);
    expect(state.served).toBeUndefined();
    expect(apply(state, served("k1"))).toMatchObject({ noop: true, journal: [] });
  });

  test("v75e_event_outside_running_or_stale_attempt_is_a_noop", () => {
    const running = started();
    // another attempt, another step, a step that is not the agent's: nothing happened, nothing refused
    expect(apply(running, served("k", 2))).toMatchObject({ noop: true });
    expect(apply(running, served("k", 1, "approve"))).toMatchObject({ noop: true });
    const ended = apply(running, { type: "cancel" }).state;
    expect(apply(ended, served("k"))).toMatchObject({ noop: true });
    const gone = apply(running, { type: "agent_completed", node: "write", attempt: 1 }).state;
    expect(apply(gone, served("k"))).toMatchObject({ noop: true });
  });

  test("v75e_file_cap_per_attempt", () => {
    let state = started();
    for (let i = 0; i < MAX_SERVED_PER_ATTEMPT; i++) state = apply(state, served(`k${i}`)).state;
    expect(apply(state, served("one-more"))).toMatchObject({ noop: true, journal: [] });
  });

  test("v75e_event_cap_per_run_is_shared_with_write_failures", () => {
    const state = { ...started(), servedEvents: MAX_SERVED_EVENTS - 1 };
    const last = apply(state, served("k"));
    expect(last.journal).toHaveLength(1);
    expect(apply(last.state, served("other"))).toMatchObject({ noop: true, journal: [] });
    const failed: RunEvent = {
      type: "served_write_failed",
      node: "write",
      attempt: 1,
      n: 1,
      message: "disk full",
    };
    expect(apply(last.state, failed)).toMatchObject({ noop: true, journal: [] });
    expect(apply(state, failed).journal[0]).toMatchObject({
      event: "served_write_failed",
      n: 1,
      message: "disk full",
    });
  });

  test("v75e_report_says_not_collected_without_the_state_key_and_counts_with_it", () => {
    const without = started(false);
    expect(summarizeRun(without, []).prompts).toEqual({ not_collected: true });
    const first = apply(started(), served("k1"));
    const second = apply(first.state, served("k2"));
    const journal = [...first.journal, ...second.journal];
    expect(summarizeRun(second.state, journal).prompts).toEqual({ served: 2 });
    expect(summarizeRun(started(), []).prompts).toEqual({ served: 0 });
  });
});

describe("the core does no I/O", () => {
  test("v75e_core_has_no_io_imports", () => {
    const root = join(import.meta.dir, "..", "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
      });
    const sources = walk(root);
    expect(sources.length).toBeGreaterThan(10);
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/from\s+["']node:(crypto|fs|child_process)/);
    }
  });
});
