import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  commonNodeShape,
  defaultRegistry,
  docTopics,
  edgeSchema,
  type PipelineHost,
  PipelineService,
  PLACEHOLDERS,
  parsePipeline,
  Registry,
  topSchema,
  undescribedFields,
} from "../src";
import { CONTRACT_VERSION, invokeTool, TOOLS } from "../src/mcp";

/** A host that fails on any call: the docs must not need it. */
const host = new Proxy({} as PipelineHost, {
  get: () => () => {
    throw new Error("docs touched the host");
  },
});
const service = () => new PipelineService(host, { engineVersion: "9.9.9" });
const topics = docTopics(defaultRegistry());

describe("pipeline_docs", () => {
  test("tNN_the_index_has_the_engine_version_and_a_line_per_topic", async () => {
    const index = await service().docs({});
    expect(index).toMatchObject({ ok: true, engine_version: "9.9.9" });
    expect(index.ok && index.topics).toEqual(
      topics.map((t) => ({ topic: t.topic, summary: t.summary })),
    );
  });

  test("tNN_docs_need_no_host_and_no_run", async () => {
    const read = await invokeTool(service(), "pipeline_docs", { topic: "checks" });
    expect(read).toMatchObject({ ok: true, topic: "checks" });
    const tool = TOOLS.find((t) => t.name === "pipeline_docs");
    expect([tool?.readOnly, tool?.idempotent]).toEqual([true, true]);
  });

  test("the pipeline spec topic names every placeholder the parser accepts", async () => {
    const read = await invokeTool(service(), "pipeline_docs", { topic: "pipeline-spec" });
    const text = String((read as Record<string, unknown>).text);
    for (const name of PLACEHOLDERS) expect(text).toContain(`{{${name}}}`);
  });

  test("tNN_the_index_from_the_tool_names_the_contract_version", async () => {
    const index = await invokeTool(service(), "pipeline_docs", {});
    expect(index).toMatchObject({ ok: true, contract_version: CONTRACT_VERSION });
  });

  test("tNN_an_unknown_topic_is_refused_with_the_list_of_topics", async () => {
    const refused = await service().docs({ topic: "nope" });
    expect(refused).toMatchObject({ ok: false, code: "UNKNOWN_TOPIC" });
    for (const t of topics) expect(!refused.ok && refused.message).toContain(t.topic);
  });

  test("tNN_every_yaml_block_in_every_topic_is_a_pipeline_the_parser_accepts", () => {
    let blocks = 0;
    for (const t of topics) {
      for (const [, body] of t.text.matchAll(/```yaml\n([\s\S]*?)```/g)) {
        blocks++;
        expect(() => parsePipeline(body ?? ""), t.topic).not.toThrow();
      }
    }
    expect(blocks).toBeGreaterThanOrEqual(3);
  });

  test("tNN_pipeline_design_hands_over_through_the_tool", () => {
    const design = topics.find((t) => t.topic === "pipeline-design")?.text ?? "";
    expect(design).toContain("pipeline_propose_change");
    expect(design).toContain("pipeline_proposal.apply");
    expect(design).toContain("Changing a pipeline that exists");
    expect(design).toContain("pipeline_resolve");
    // the person no longer copies the file by hand
    expect(design).not.toContain("let them save it");
    expect(design).not.toContain("you cannot put it in place yourself");
  });

  test("tNN_every_topic_linked_from_a_topic_exists_and_every_topic_is_linked", () => {
    const names = new Set(topics.map((t) => t.topic));
    const linked = new Set(
      topics.flatMap((t) => [...t.text.matchAll(/\(docs:([a-z-]+)\)/g)].map((m) => m[1])),
    );
    for (const name of linked) expect(names.has(name ?? ""), String(name)).toBe(true);
    for (const name of names)
      expect(name === "pipeline-design" || linked.has(name), name).toBe(true);
  });

  test("tNN_a_topic_stays_small_enough_to_read_on_every_call", () => {
    for (const t of topics) expect(t.text.length, t.topic).toBeLessThan(12_000);
  });
});

describe("the generated reference", () => {
  const registry = defaultRegistry();
  const text = (name: string) => topics.find((t) => t.topic === name)?.text ?? "";

  test("tNN_it_names_every_field_of_every_registered_node_and_check_kind", () => {
    for (const kind of registry.nodeKinds()) {
      for (const field of Object.keys(registry.node(kind)?.shape ?? {})) {
        expect(text("pipeline-spec"), `${kind}.${field}`).toContain(`\`${field}\``);
      }
    }
    for (const kind of registry.checkKinds()) {
      for (const field of Object.keys(registry.check(kind)?.shape ?? {})) {
        expect(text("checks"), `${kind}.${field}`).toContain(`\`${field}\``);
      }
    }
    const generic = [...Object.keys(topSchema.shape), ...Object.keys(commonNodeShape)];
    for (const field of [...generic, ...Object.keys(edgeSchema.shape), "checks"]) {
      expect(text("pipeline-spec"), field).toContain(`\`${field}\``);
    }
    expect(text("checks")).toContain("`on_fail`");
  });

  test("tNN_a_kind_registered_later_shows_up_with_no_change_to_the_docs", () => {
    const plugin = new Registry().registerCheck({
      kind: "coverage",
      shape: { floor: z.number().describe("The lowest coverage that passes.") },
    });
    const checks = docTopics(plugin).find((t) => t.topic === "checks")?.text ?? "";
    expect(checks).toContain("Check kind `coverage`");
    expect(checks).toContain("The lowest coverage that passes.");
    const node = new Registry().registerNode({
      kind: "deploy",
      shape: { target: z.string().describe("Where to deploy.") },
      allowsChecks: false,
      requiresRoutes: true,
      automaticFailures: true,
      labels: () => ({ success: ["passed"], failure: ["failed"] }),
      begin: () => ({ needs: "engine", command: "true", expect: { exit: 0 } }),
    });
    const spec = docTopics(node).find((t) => t.topic === "pipeline-spec")?.text ?? "";
    expect(spec).toContain("Node kind `deploy`");
    expect(spec).toContain("Where to deploy.");
  });

  test("tNN_a_union_in_a_list_is_put_in_parentheses", () => {
    const checks = docTopics(defaultRegistry()).find((t) => t.topic === "checks")?.text ?? "";
    expect(checks).toContain("map of (string \\| boolean)[]");
  });

  test("tNN_a_field_without_a_description_is_a_hole_and_is_found", () => {
    expect(undescribedFields({ a: z.string(), b: z.string().describe("b") })).toEqual(["a"]);
    const shapes = [
      topSchema.shape,
      commonNodeShape,
      edgeSchema.shape,
      ...registry.nodeKinds().map((k) => registry.node(k)?.shape ?? {}),
      ...registry.checkKinds().map((k) => registry.check(k)?.shape ?? {}),
    ];
    for (const shape of shapes) expect(undescribedFields(shape)).toEqual([]);
  });

  test("tNN_a_type_the_docs_cannot_describe_stops_instead_of_vanishing", () => {
    const odd = new Registry().registerCheck({ kind: "odd", shape: { x: z.date() } });
    expect(() => docTopics(odd)).toThrow("cannot describe");
  });

  const topicText = (name: string) => topics.find((t) => t.topic === name)?.text ?? "";
  const design = () => topicText("pipeline-design");
  /** The text of one `##`/`###` section, up to the next heading of the same or a higher level. */
  const section = (text: string, heading: string) => {
    const start = text.indexOf(heading);
    expect(start, heading).toBeGreaterThanOrEqual(0);
    const level = /^#+/.exec(heading)?.[0].length ?? 2;
    const rest = text.slice(start + heading.length);
    const end = rest.search(new RegExp(`\\n#{1,${level}} `));
    return end < 0 ? rest : rest.slice(0, end);
  };
  const exampleYaml = (name: string) => {
    for (const [, body] of topicText("examples").matchAll(/```yaml\n([\s\S]*?)```/g)) {
      const pipeline = parsePipeline(body ?? "");
      if (pipeline.name === name) return pipeline;
    }
    throw new Error(`no example named ${name}`);
  };

  test("tr5j7_design_topic_asks_for_a_diagram_and_a_description_of_each_step", () => {
    const handOver = section(design(), "## 5. Hand it over");
    expect(handOver).toContain("(`kind: new`");
    expect(handOver).toContain("->");
    expect(handOver).toContain("One plain sentence for each step");
  });

  test("tr5j7_standard_and_strict_end_with_the_same_result_check", () => {
    const ends = ["standard", "strict"].map((name) => {
      const pipeline = exampleYaml(name);
      const last = pipeline.nodes.find((n) => n.slug === "result-approval");
      expect(last?.kind, name).toBe("human");
      const edges = pipeline.edges.filter((e) => e.from === "result-approval");
      expect(
        edges.map((e) => [e.to, e.when]),
        name,
      ).toEqual([["impl", "rejected"]]);
      // reached from the last automated step: `test` in standard, `review` in strict
      const before = name === "standard" ? "test" : "review";
      expect(
        pipeline.edges.filter((e) => e.to === "result-approval").map((e) => [e.from, e.when]),
        name,
      ).toEqual([[before, "passed"]]);
      return JSON.stringify(last);
    });
    expect(ends[0]).toBe(ends[1]);
  });

  test("tr5j7_profile_table_matches_the_examples", () => {
    const text = design();
    expect(text).toMatch(/\| `standard` \|[^\n]*result check by a person/);
    expect(text).toMatch(/\| `strict` \|[^\n]*independent review/);
    const strict = topicText("examples").split("## strict:")[1] ?? "";
    const [heading = "", ...rest] = strict.split("\n");
    expect(heading).toContain("independent review");
    expect(heading).not.toContain("result gate");
    const intro = rest.find((l) => l.startsWith("Like `standard`")) ?? "";
    expect(intro).toContain("independent review");
    expect(intro).toContain("is the same");
    expect(intro).not.toContain("and a person's approval at the end.");
  });

  test("tr5j7_design_topic_offers_stricter_and_faster_cheaper_modes", () => {
    const after = section(design(), "### After the proposal");
    expect(after).toMatch(/\*\*Stricter\*\*/);
    expect(after).toMatch(/\*\*Faster and cheaper\*\*/);
    const flat = after.replace(/\s+/g, " ");
    // stricter = more checks the project has, or more reviews by subagents; no limits of the file
    for (const word of [
      "(tests, linter, build)",
      "reviews by subagents",
      "independent review in a fresh context",
      "security",
      "business role",
      "`lean`",
      "`test` step",
      "plan check",
    ]) {
      expect(flat, word).toContain(word);
    }
    expect(after).not.toContain("max_lines");
    expect(after).not.toContain("max_attempts");
    // the profiles named are real: they are in the table
    for (const profile of ["lean", "strict"]) {
      expect(design(), profile).toMatch(new RegExp(`\\| \`${profile}\` \\|`));
    }
  });

  test("tr5j7_design_topic_invites_a_description_of_the_way_of_working", () => {
    const after = section(design(), "### After the proposal");
    expect(after).toContain("describe how they work in more detail");
    expect(after).toContain("(docs:pipeline-quality)");
    expect(after).toContain("propose again with");
  });

  test("tr5j7_hand_over_says_where_the_pipeline_is_and_where_to_accept_it", () => {
    const handOver = section(design(), "## 5. Hand it over").replace(/\s+/g, " ");
    expect(handOver).toContain("`kodel pipeline proposals show <name>`");
    expect(handOver).toContain("`.kodel/pipelines/<name>.yaml` in the project root");
    expect(handOver).toContain(
      "on a line of its own, with the words that it is run in the project root",
    );
  });

  test("tr5j7_modes_and_commands_belong_to_a_new_pipeline_and_come_after_the_proposal", () => {
    const text = design();
    const propose = text.indexOf("Call `pipeline_propose_change` without `run_id`");
    expect(propose).toBeGreaterThanOrEqual(0);
    for (const heading of ["### Once the person accepts it", "### After the proposal"]) {
      expect(text.indexOf(heading), heading).toBeGreaterThan(propose);
    }
    expect(text.indexOf("### After the proposal")).toBeLessThan(
      text.indexOf("## 6. Changing a pipeline that exists"),
    );
    expect(section(text, "## 5. Hand it over")).toContain("never a question before it");
    expect(section(text, "## 1. Ask how much to ask")).toContain("ask nothing more");
    // a change of an existing pipeline is not given the tutorial
    expect(section(text, "## 6. Changing a pipeline that exists")).not.toContain(
      "After the proposal",
    );
  });

  /** What breaks the rule that the commands listed are the person's and are only the basic ones. */
  const commandTextBreaks = (text: string) => {
    const flat = text.replace(/\s+/g, " ");
    return [
      ...(flat.includes("The commands are the person's; the agent never runs them")
        ? []
        : ["the list is not introduced as the person's"]),
      // decisions and watching are not listed: the agent gives the command when one is needed
      ...text.split("\n").filter((l) => /`(gate|resume|ack|seal|wait|report)\b/.test(l)),
      ...text.split("\n").filter((l) => /\byou\b/i.test(l)),
    ];
  };

  test("tr5j7_design_topic_says_decisions_are_the_persons", () => {
    const text = section(design(), "### Once the person accepts it");
    expect(commandTextBreaks(text)).toEqual([]);
    expect(text.replace(/\s+/g, " ")).toContain("the agent gives the command when one is needed");
    // what a run does after it starts is said, so the person is not left guessing
    const flat = text.replace(/\s+/g, " ");
    // the flow is the proposed pipeline's own, and the engine, not the agent, runs the checks
    expect(flat).toContain(
      "for the steps of the pipeline that was proposed and not for another one",
    );
    expect(flat).toContain("the engine, not the agent, decides that a step is done");
    expect(flat).toContain("`lean` has no planned stop");
    expect(flat).toContain("Any run also pauses for the person when a step keeps failing");
    expect(flat).toContain("`kodel status` lists the runs; `kodel status <run>` shows one run");
    // refutation: a listed decision command, or a "you", fails the same check
    for (const bad of [
      "- `gate approve <run>` decides at a check",
      "- run `resume <run>` yourself",
      "- `wait <run>` stays until you decide",
    ]) {
      expect(commandTextBreaks(`${text}\n${bad}`), bad).not.toEqual([]);
    }
    expect(
      commandTextBreaks(text.replace("The commands are the person's", "The commands are")),
    ).not.toEqual([]);
  });

  test("tr5j7_quality_topic_has_the_reference_shape_the_report_and_the_checklist", () => {
    const text = topicText("pipeline-quality");
    const shape = section(text, "## The reference shape");
    // seven steps, in order, with the person at two of them only
    const steps = [...shape.matchAll(/^(\d)\. \*\*([^*]+)\*\*/gm)].map((m) => [m[1], m[2]]);
    expect(steps.map(([n]) => n)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(steps.map(([, name]) => name)).toEqual([
      "Plan, read only.",
      "Plan check by the person.",
      "Implement.",
      "Feedback loop.",
      "Report.",
      "Result check by the person.",
      "Final steps.",
    ]);
    // the report goes from what matters to the details
    const report = section(text, "## The report");
    const order = ["First:", "Then:", "Last: details"].map((w) => report.indexOf(w));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // the person is not asked in the middle of a step
    expect(section(text, "## Attention budget")).toContain("Never end a step by asking");
    // the checklist is a list of questions
    const checklist = section(text, "## A checklist for a pipeline that exists");
    // an item may wrap onto a second line: count the items, and every one ends with a question mark
    const items = checklist
      .split(/^- /m)
      .slice(1)
      .map((i) => i.trim().replace(/\s+/g, " "));
    expect(items.length).toBeGreaterThanOrEqual(8);
    for (const item of items) expect(item.endsWith("?"), item).toBe(true);
    // the claims fit the format: the fields it names exist in the reference, the model is not one of them
    const reference = `${topicText("pipeline-spec")}\n${topicText("checks")}`;
    for (const field of ["max_lines", "max_attempts", "max_consecutive_failures"]) {
      expect(text, field).toContain(field);
      expect(reference, field).toContain(field);
    }
    // the reference lists fields as table cells; the model is not one of them, and the check can fail
    const hasField = (table: string, name: string) =>
      new RegExp("\\|\\s*`" + name + "`\\s*\\|").test(table);
    expect(hasField(reference, "max_attempts")).toBe(true);
    expect(hasField(reference, "model")).toBe(false);
    expect(hasField(`${reference}\n| \`model\` | string | no | x |`, "model")).toBe(true);
    expect(text).toContain("not a field of the pipeline");
    // it says what the engine has the agent write at a human node, and that the order is asked in `instructions`
    expect(text.replace(/\s+/g, " ")).toContain(
      "so the order of the report is asked for in `instructions`",
    );
    // the generated reference of the field carries the same
    expect(topicText("pipeline-spec")).toContain("holds and in which order");
    // a split of the work also takes the tests out of impl
    expect(text.replace(/\s+/g, " ")).toContain("`mode: unchanged` on `test/**` in `impl`");
    expect(text).not.toContain("this repository's own pipeline");
    // the examples ask for the report the topic describes, in its order
    for (const name of ["standard", "strict"]) {
      const node = exampleYaml(name).nodes.find((n) => n.slug === "result-approval");
      const instructions = String(node?.params.instructions);
      expect(instructions, name).toContain("what was done");
      expect(instructions, name).toContain("The message to the person is the report");
      expect(instructions.indexOf("details last"), name).toBeGreaterThan(
        instructions.indexOf("the checks that ran"),
      );
    }
  });

  test("tr5j7_quality_topic_offers_stronger_review_more_reviews_and_decomposition", () => {
    const price = section(topicText("pipeline-quality"), "## Better quality, at a price");
    for (const word of [
      "stronger model",
      "security review",
      "business",
      "Decompose",
      "tests apart",
    ]) {
      expect(price, word).toContain(word);
    }
  });

  test("tr5j7_the_design_topic_points_to_the_quality_topic", () => {
    expect(design()).toContain("(docs:pipeline-quality)");
    expect(topics.map((t) => t.topic)).toContain("pipeline-quality");
  });

  test("tr5j7_minimal_example_keeps_both_human_checks_and_has_no_command_steps", () => {
    const minimal = exampleYaml("minimal");
    expect(minimal.nodes.map((n) => [n.slug, n.kind])).toEqual([
      ["plan", "agent"],
      ["plan-approval", "human"],
      ["impl", "agent"],
      ["result-approval", "human"],
    ]);
    // the same result check as standard and strict
    const result = (name: string) =>
      JSON.stringify(exampleYaml(name).nodes.find((n) => n.slug === "result-approval")?.params);
    expect(result("minimal")).toBe(result("standard"));
    expect(
      minimal.edges.filter((e) => e.from === "result-approval").map((e) => [e.to, e.when]),
    ).toEqual([["impl", "rejected"]]);
    // impl is reached only through the plan check (approved) or back from the result check (rejected)
    expect(minimal.edges.filter((e) => e.to === "impl").map((e) => [e.from, e.when])).toEqual([
      ["plan-approval", "approved"],
      ["result-approval", "rejected"],
    ]);
    // every agent node has a check, as checks.md asks, and impl may not touch the plan
    for (const node of minimal.nodes.filter((n) => n.kind === "agent")) {
      expect(node.checks.length, node.slug).toBeGreaterThan(0);
    }
    // impl may not touch the plan: a diff check of mode unchanged on the plans
    const impl = minimal.nodes.find((n) => n.slug === "impl");
    expect(
      impl?.checks.some(
        (c) => JSON.stringify(c).includes("unchanged") && JSON.stringify(c).includes("docs/plans"),
      ),
    ).toBe(true);
  });

  test("tr5j7_an_empty_project_gets_the_minimal_form_and_the_two_modes_differ", () => {
    const text = design().replace(/\s+/g, " ");
    const rule = text.slice(text.indexOf("**A project that gives no commands**"));
    expect(rule).toContain("do not choose `lean`");
    expect(rule).toContain("the `minimal` example");
    expect(rule).toContain("never invent one");
    // the diff checks of the minimal form need a git work tree, and the example says so too
    expect(rule).toContain("`git init` and a first commit of the project's files come first");
    expect(topicText("examples").replace(/\s+/g, " ")).toContain(
      "needs `git init` and a first commit of its files before the first run",
    );
    // on your own: no question, the assumption first; together: one question with a default
    expect(rule).toMatch(/"on your own" mode ask nothing: say first in the message/);
    expect(rule).toMatch(/"together" mode ask once what they are building/);
    // the offers after the proposal fit the minimal form, and section 1 points to the rule
    const after = section(design(), "### After the proposal").replace(/\s+/g, " ");
    expect(after).toContain(
      "Offer only what fits the pipeline you proposed. For the `minimal` form",
    );
    expect(after).toContain(
      "nothing would be left to check, or the project has no commands to check with",
    );
    const first = section(design(), "## 1. Ask how much to ask").replace(/\s+/g, " ");
    expect(first).toContain("which section 3 settles first");
    expect(first).toContain("one question for a project that gives no commands");
    // lean is kept for projects that have commands to verify with
    expect(text).toMatch(/\| `lean` \|[^|]*\| [^|]*has commands to verify with/);
  });

  test("tr5j7_decomposition_names_the_way_back_to_the_tests_step", () => {
    const quality = topicText("pipeline-quality").replace(/\s+/g, " ");
    expect(quality).toContain("an `outcomes` label");
    expect(quality).toContain(
      "max_consecutive_failures` or `max_attempts`, whichever is reached first",
    );
    expect(quality).not.toContain("`max_consecutive_failures`, then `max_attempts`");
  });
});
