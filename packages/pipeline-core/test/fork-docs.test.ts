/**
 * What the texts say about forks (T-40): the docs topic the agent reads, the example pipeline, the
 * notes for people (`docs/changes.md`, the driver section of `AGENTS.md`), the server's instructions
 * and the tool descriptions.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRegistry, docTopics, parsePipeline, validatePipeline } from "../src";
import { serverInstructions, TOOLS } from "../src/mcp";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(REPO, ...parts), "utf8");
const topics = docTopics(defaultRegistry());
const topic = (name: string) => topics.find((t) => t.topic === name)?.text ?? "";

describe("t40 the docs of forks", () => {
  test("t40_docs_pipeline_spec_covers_forks", () => {
    const spec = topic("pipeline-spec");
    for (const phrase of [
      "## Forks",
      "`join: all`",
      "`restart_failed`",
      "do not list it in `outcomes`",
      "`steps`",
      "`pipeline_take_step`",
      "`claim_token`",
      "`agents.claim_ttl_s`",
      "`agents.max_parallel`",
      "`agents.subagents`",
      "never refuses a completion for a missing one",
      "share one working tree",
      "not a check of that branch alone",
      "join's checks",
      "may overlap",
      "Nested forks are refused",
      "deliberate limit",
      "cannot route a failure to a",
      "No node is shared between branches",
      "repair step cannot serve two branches",
    ]) {
      expect(spec, phrase).toContain(phrase);
    }
    expect(spec).toMatch(/second edge with the same `from` and `when` used to\s+be ignored/);
    // the generated reference names the field
    expect(spec).toContain("`join`");
  });

  test("t40_docs_example_validates", () => {
    const text = read("examples", "pipelines", "fork.yaml");
    const result = validatePipeline(text);
    expect(result.ok).toBe(true);
    const spec = parsePipeline(text);
    const join = spec.nodes.find((n) => n.join !== undefined);
    expect(join?.slug).toBe("fix");
    expect(join?.kind).toBe("agent");
    // two edges with the same from and when: the fork
    const fromImpl = spec.edges.filter((e) => e.from === "impl");
    expect(fromImpl.map((e) => e.to).sort()).toEqual(["test", "verify"]);
    // the same pipeline is the example in the docs
    const examples = topic("examples");
    expect(examples).toContain("## fork");
    const block = /## fork[\s\S]*?```yaml\n([\s\S]*?)```/.exec(examples)?.[1] ?? "";
    expect(parsePipeline(block).nodes.map((n) => n.slug)).toEqual(spec.nodes.map((n) => n.slug));
    // every command is valid in cmd.exe too: `node -e` with double quotes, no shell operators
    for (const node of spec.nodes) {
      const command = node.params.command;
      if (typeof command !== "string") continue;
      expect(command).toMatch(/^node -e "[^"]*"$/);
      expect(command).not.toMatch(/&&|\|\||;|>|</);
    }
  });

  test("t40_docs_changes_md_has_overlap_and_beta_sentences", () => {
    const changes = read("docs", "changes.md");
    expect(changes).toContain("patches of hand-ins of open steps may overlap");
    expect(changes).toContain("changes_note");
    expect(changes).toContain(
      "back-off after two slow hand-ins is not applied while another branch is active",
    );
    expect(changes).toContain("0.1.0-beta.0");
    expect(changes).toContain("cannot read a fork run");
  });

  test("t40_agents_md_driver_text_has_worker_rules", () => {
    const text = read("AGENTS.md");
    const start = text.indexOf("## Running a pipeline on this repository");
    const end = text.indexOf("## Language");
    expect(start).toBeGreaterThan(0);
    const driver = text.slice(start, end);
    for (const phrase of [
      "`steps`",
      "`execution.mode`",
      "`pipeline_take_step`",
      "`claim_token`",
      "`pipeline_complete_step`",
      "report the answer back",
      "never write to\n  the person",
      "never start `kodel wait` as a worker",
      "`sequential` mode",
      "`also_waiting`",
      "`--node <slug>`",
    ]) {
      expect(driver, phrase).toContain(phrase);
    }
  });

  test("t40_fixtures_readme_says_not_to_open_a_fork_run_with_the_beta", () => {
    const readme = read("fixtures", "formats", "README.md");
    expect(readme).toContain("Do not open a fork run with the beta");
    expect(readme).toContain("r_0mvthh4vp_9gqe");
    expect(readme).toContain("restart_failed");
  });

  test("t40_server_instructions_cover_steps_workers_and_also_waiting", () => {
    for (const waitHint of [true, false]) {
      const text = serverInstructions({ waitHint });
      for (const phrase of [
        "`steps`",
        "`execution.mode`",
        "pipeline_take_step",
        "`claim_token`",
        "one worker per free step",
        "`open_steps`",
        "`also_waiting`",
        "pipeline_next_step only reads; it never takes a step",
      ]) {
        expect(text, phrase).toContain(phrase);
      }
      expect(text.includes("never starts `kodel wait`")).toBe(waitHint);
    }
  });

  test("t40_feedback_description_says_node_slug", () => {
    const feedback = TOOLS.find((t) => t.name === "pipeline_feedback");
    expect(feedback?.description).toContain("node_slug");
    expect(feedback?.description).toContain("several steps open at once");
  });
});
