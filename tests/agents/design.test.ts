import { describe, expect, test } from "bun:test";
import { parsePipeline } from "../../packages/pipeline-core/src";
import {
  commandsNotRun,
  FIXTURES,
  judgePrompt,
  missingCommands,
  parseVerdicts,
  peopleOnlyCommands,
  pipelineCommands,
  programOf,
  summaryGaps,
  trailBreaks,
} from "./design";

const PIPELINE = [
  "name: lean",
  "nodes:",
  "  - slug: impl",
  "    kind: agent",
  "    prompt: Make the change for {{task}}.",
  "    checks:",
  '      - { kind: command, command: "npm run lint" }',
  "  - slug: test",
  "    kind: command",
  '    command: "npm test"',
  "  - slug: approve",
  "    kind: human",
  "    prompt: ok?",
  "edges:",
  "  - { from: impl, to: test }",
  "  - { from: test, to: impl, when: failed }",
  "  - { from: test, to: approve }",
  "  - { from: approve, to: impl, when: rejected }",
  "",
].join("\n");

const spec = parsePipeline(PIPELINE);
const [pLimit] = FIXTURES;

describe("the checks of the kodel-design scenario that need no agent", () => {
  test("t2t8e_commands_are_read_from_steps_and_from_checks", () => {
    expect(pipelineCommands(spec)).toEqual(["npm run lint", "npm test"]);
  });

  test("t2t8e_a_checklist_command_the_pipeline_lacks_is_named", () => {
    expect(missingCommands(spec, pLimit as NonNullable<typeof pLimit>)).toEqual([]);
    const without = parsePipeline(PIPELINE.replace('"npm test"', '"echo ok"'));
    expect(missingCommands(without, pLimit as NonNullable<typeof pLimit>)).toEqual(["npm test"]);
  });

  test("t2t8e_the_program_of_a_command_is_found_without_a_shell", () => {
    expect(programOf("npm test")).toBe("npm");
    expect(programOf("CI=1 FOO=bar uv run pytest")).toBe("uv");
    expect(programOf(".venv/bin/ruff check .")).toBe(".venv/bin/ruff");
    expect(programOf("$RUNNER test")).toBeUndefined();
    expect(programOf("$(which npm) test")).toBeUndefined();
    expect(programOf("  ")).toBeUndefined();
  });

  test("t2t8e_the_judge_answer_fails_closed", () => {
    const items = ["a", "b"];
    const ok = parseVerdicts(
      'Here: [{"met":true,"evidence":"x"},{"met":false,"evidence":"y"}]',
      items,
    );
    expect(ok.map((v) => v.met)).toEqual([true, false]);
    expect(ok[1]?.item).toBe("b");
    expect(() => parseVerdicts("fine", items)).toThrow();
    expect(() => parseVerdicts('[{"met":true}]', items)).toThrow();
    expect(() => parseVerdicts('[{"met":"yes"},{"met":true}]', items)).toThrow();
    expect(() => parseVerdicts('[{"met":true},{"met":true,"evidence":" "}]', items)).toThrow();
  });

  test("t2t8e_the_judge_sees_the_pipeline_and_the_summary_only", () => {
    const prompt = judgePrompt("name: x", "assumed npm", ["one", "two"]);
    expect(prompt).toContain("1. one");
    expect(prompt).toContain("name: x");
    expect(prompt).toContain("assumed npm");
  });

  test("t2t8e_the_fixtures_are_pinned", () => {
    for (const f of FIXTURES) {
      expect(f.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(f.commands.length).toBeGreaterThan(0);
      expect(f.checklist.length).toBeGreaterThan(0);
    }
  });

  test("t2t8e_a_summary_without_the_profile_or_a_command_is_found", () => {
    const fixture = pLimit as NonNullable<typeof pLimit>;
    expect(summaryGaps("Profile standard; runs npm test.", fixture)).toEqual([]);
    expect(summaryGaps("Runs npm test.", fixture)).toEqual([
      "the profile (lean, standard or strict)",
    ]);
    expect(summaryGaps("Profile lean.", fixture)).toEqual(["the command npm test"]);
  });

  test("t2t8e_a_run_that_leaves_the_edges_is_found", () => {
    expect(trailBreaks(spec, ["impl", "test", "approve"])).toEqual([]);
    expect(trailBreaks(spec, ["impl", "test", "impl", "test", "approve"])).toEqual([]);
    expect(trailBreaks(spec, ["impl", "approve"])).toEqual(["impl > approve"]);
    expect(trailBreaks(spec, ["test", "approve"])).toEqual(["starts at test, not impl"]);
  });

  test("t2t8e_commands_that_never_ran_are_found", () => {
    const ran = { event: "check_finished", node: "impl", kind: "command", passed: true };
    expect(commandsNotRun(spec, ["impl", "test", "approve"], [ran])).toEqual([]);
    expect(commandsNotRun(spec, ["impl", "approve"], [ran])).toEqual(["test (step)"]);
    expect(commandsNotRun(spec, ["impl", "test"], [{ ...ran, passed: false }])).toEqual([
      "impl (check)",
    ]);
    expect(commandsNotRun(spec, ["impl", "test"], [])).toEqual(["impl (check)"]);
  });

  test("t2t8e_a_command_that_is_a_persons_to_run_is_found", () => {
    const bash = (command: string) => ({ name: "Bash", input: { command } });
    expect(peopleOnlyCommands([bash("npm test"), bash("ls .kodel")])).toEqual([]);
    expect(
      peopleOnlyCommands([{ name: "Read", input: { command: "kodel gate approve" } }]),
    ).toEqual([]);
    expect(peopleOnlyCommands([bash("kodel pipeline proposals apply lean")])).toHaveLength(1);
    expect(
      peopleOnlyCommands([bash("bun packages/cli/src/main.ts gate approve r_1")]),
    ).toHaveLength(1);
  });
});
