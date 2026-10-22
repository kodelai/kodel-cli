import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  commonNodeShape,
  defaultRegistry,
  docTopics,
  edgeSchema,
  type PipelineHost,
  PipelineService,
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
});
