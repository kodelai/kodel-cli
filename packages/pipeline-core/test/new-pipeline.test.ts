import { describe, expect, test } from "bun:test";
import {
  commandsOf,
  hiddenCharacterProblem,
  type PipelineHost,
  type PipelineProposalOutcome,
  PipelineService,
  type PipelineSpec,
  parsePipeline,
  proposalNameProblem,
} from "../src";
import { invokeTool, SERVER_INSTRUCTIONS, TOOLS } from "../src/mcp";

// The test ids are a placeholder until the decision log gives this change one (see the plan).

const demo = parsePipeline(
  [
    "name: demo",
    "nodes:",
    "  - slug: build",
    "    kind: command",
    "    command: make",
    "  - slug: write",
    "    kind: agent",
    "    prompt: write it",
    "    checks:",
    "      - { kind: command, command: 'node check.js' }",
    "      - { kind: diff, paths: ['src/**'] }",
    "edges:",
    "  - { from: build, to: write }",
    "  - { from: build, to: write, when: failed }",
    "",
  ].join("\n"),
);

/** A host that keeps what it is asked and answers the simplest way; the rest of the host is not used. */
class ProposingHost {
  readonly proposed: { yaml: string; summary: string; name?: string }[] = [];
  outcome: PipelineProposalOutcome = {
    ok: true,
    status: "proposed",
    proposal: { name: "demo", kind: "new", apply: "kodel pipeline proposals apply demo" },
  };
  async list() {
    return { pipelines: [], problems: [] };
  }
  async resolve(name: string): Promise<PipelineSpec | undefined> {
    return name === "demo" ? demo : undefined;
  }
  async resolveSource(name: string) {
    return name === "demo" ? { spec: demo, yaml: "name: demo\n", hash: "abc" } : undefined;
  }
  async proposePipeline(input: { yaml: string; summary: string; name?: string }) {
    this.proposed.push(input);
    return this.outcome;
  }
  async start(): Promise<never> {
    throw new Error("not used");
  }
  async open() {
    return undefined;
  }
}

const svc = (host: object) => new PipelineService(host as PipelineHost);

describe("a pipeline proposed without a run", () => {
  test("tNN_a_new_pipeline_is_proposed_without_a_run", async () => {
    const host = new ProposingHost();
    const answer = await invokeTool(svc(host), "pipeline_propose_change", {
      pipeline: "name: demo\n",
      summary: "why",
    });
    expect(answer).toMatchObject({
      ok: true,
      status: "proposed",
      pipeline_proposal: {
        name: "demo",
        kind: "new",
        apply: "kodel pipeline proposals apply demo",
      },
    });
    expect(JSON.stringify(answer)).toContain("do not run it");
    expect(host.proposed).toEqual([{ yaml: "name: demo\n", summary: "why" }]);
  });

  test("tNN_taking_a_proposal_back_names_it_and_a_refusal_is_not_a_throw", async () => {
    const host = new ProposingHost();
    host.outcome = { ok: true, status: "withdrawn", name: "demo" };
    const back = await invokeTool(svc(host), "pipeline_propose_change", {
      pipeline: "",
      summary: "s",
      name: "demo",
    });
    expect(back).toMatchObject({ ok: true, status: "withdrawn", name: "demo" });
    expect(host.proposed[0]?.name).toBe("demo");
    host.outcome = { ok: false, code: "PIPELINE_CHANGE_REFUSED", message: "no" };
    expect(
      await invokeTool(svc(host), "pipeline_propose_change", { pipeline: "x", summary: "s" }),
    ).toMatchObject({ ok: false, code: "PIPELINE_CHANGE_REFUSED", message: "no" });
  });

  test("tNN_a_host_without_the_method_refuses", async () => {
    const host = { list: async () => ({ pipelines: [], problems: [] }) };
    expect(
      await invokeTool(svc(host), "pipeline_propose_change", { pipeline: "x", summary: "s" }),
    ).toMatchObject({ ok: false, code: "PIPELINE_CHANGE_REFUSED" });
  });

  test("tNN_resolve_without_a_run_returns_the_text_and_its_hash", async () => {
    const answer = await svc(new ProposingHost()).resolve({ pipeline: "demo" });
    expect(answer).toMatchObject({ ok: true, yaml: "name: demo\n", version: "abc" });
    // a host that cannot give the text still gives the spec
    const plain = { resolve: async () => demo };
    const spec = await svc(plain).resolve({ pipeline: "demo" });
    expect(spec).toMatchObject({ ok: true });
    expect(spec.ok && "yaml" in spec).toBe(false);
  });

  test("tNN_the_tool_and_the_instructions_name_the_proposal", () => {
    const tool = TOOLS.find((t) => t.name === "pipeline_propose_change");
    expect(tool?.description).toContain("Without run_id");
    expect(tool?.description).toContain("never run that command");
    expect(SERVER_INSTRUCTIONS).toContain("pipeline_propose_change without run_id");
    expect(SERVER_INSTRUCTIONS).toContain("Never put a file in .kodel/pipelines");
    const resolve = TOOLS.find((t) => t.name === "pipeline_resolve");
    expect(resolve?.description).toContain("outside a run");
  });
});

describe("what is said about a proposed pipeline from its text", () => {
  test("tNN_a_name_that_is_not_a_file_name_is_found", () => {
    for (const ok of ["demo", "a", "my-pipeline-2"])
      expect(proposalNameProblem(ok)).toBeUndefined();
    for (const bad of ["", "Demo", "a b", "../x", "-a", "a".repeat(64), "a/b", "a.b"]) {
      expect(proposalNameProblem(bad), bad).toContain("cannot be a file name");
    }
  });

  test("tNN_characters_a_person_would_not_see_are_found_with_their_line", () => {
    expect(hiddenCharacterProblem("a\n\tb\r\n")).toBe(
      "line 2 has a character that is not shown to a person (U+000D); leave it out",
    );
    for (const code of [
      0x1b, 0x7f, 0xad, 0x34f, 0x200b, 0x200d, 0x200f, 0x2028, 0x202e, 0x2060, 0x2066, 0x2800,
      0x3164, 0xfe0f, 0xfeff, 0xe0041,
    ]) {
      expect(hiddenCharacterProblem(`x\n${String.fromCodePoint(code)}`), String(code)).toContain(
        "line 2",
      );
    }
    expect(hiddenCharacterProblem("plain text, ünïcode and 日本語\n\ttabs")).toBeUndefined();
  });

  test("tNN_a_command_that_is_not_text_is_listed_as_the_text_the_runner_would_run", () => {
    const odd = { ...demo, nodes: [{ ...demo.nodes[0], params: { command: ["make", "all"] } }] };
    expect(commandsOf(odd as unknown as PipelineSpec)[0]).toEqual({
      where: 'step "build"',
      command: "make,all",
    });
  });

  test("tNN_every_command_a_pipeline_would_run_is_listed_in_order", () => {
    expect(commandsOf(demo)).toEqual([
      { where: 'step "build"', command: "make" },
      { where: 'step "write", command check', command: "node check.js" },
    ]);
  });
});
