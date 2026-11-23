/**
 * The `attachment` check kind (T-45), the pure part: its schema, where the parser takes it, what it
 * adds to a step's prompt and to the docs, the format rule, and the verdict.
 */
import { describe, expect, test } from "bun:test";
import {
  type AttachmentRecord,
  attachmentCheck,
  attachmentRef,
  capabilitiesOf,
  checkFeaturesOf,
  decide,
  defaultRegistry,
  docTopics,
  type EngineOptions,
  evaluateAttachment,
  KodelError,
  nextStep,
  type PipelineHost,
  PipelineService,
  parsePipeline,
  parseSnapshot,
  type RunEvent,
  type RunState,
  readRunState,
  unheldCheckFeature,
  validatePipeline,
  withAttachmentKinds,
} from "../src";

const yaml = (lines: string[]) => `${lines.join("\n")}\n`;
const registry = () => withAttachmentKinds(defaultRegistry());
const parse = (source: string) => parsePipeline(source, { registry: registry() });

const withCheck = (check: string, node = "{ slug: plan, kind: agent, prompt: plan") =>
  yaml(["name: p", "nodes:", `  - ${node}, checks: [${check}] }`, "edges: []"]);

function problems(source: string): string[] {
  const result = validatePipeline(source, { registry: registry() });
  return result.ok ? [] : result.issues.map((issue) => String(issue.message));
}

describe("t45 the check kind", () => {
  test("t45_check_kind_schema", () => {
    const spec = parse(withCheck("{ kind: attachment, name: plan.md, min_lines: 10 }"));
    expect(spec.nodes[0]?.checks).toEqual([
      { kind: "attachment", on_fail: "failed", params: { name: "plan.md", min_lines: 10 } },
    ]);
    expect(
      parse(withCheck("{ kind: attachment, name: shot.png }")).nodes[0]?.checks[0]?.params,
    ).toEqual({ name: "shot.png" });
    // the name is an attachment's name; min_lines is for a text, and counts from 1
    for (const [check, message] of [
      ["{ kind: attachment }", "name"],
      ["{ kind: attachment, name: PLAN.md }", "a name is 1 to 64 characters"],
      ["{ kind: attachment, name: plan.pdf }", "must end with one of"],
      ["{ kind: attachment, name: ../plan.md }", "a name is 1 to 64 characters"],
      ["{ kind: attachment, name: shot.png, min_lines: 3 }", "min_lines is only for a text"],
      ["{ kind: attachment, name: plan.md, min_lines: 0 }", "min_lines"],
      ["{ kind: attachment, name: plan.md, max_lines: 3 }", "max_lines"],
      ["{ kind: attachment, name: plan.md, path: docs/plan.md }", "path"],
    ] as const) {
      expect(problems(withCheck(check)).join("; "), check).toContain(message);
    }
    // the kind is the host's to add: it is not one of the built-in ones
    expect(defaultRegistry().checkKinds()).not.toContain("attachment");
    expect(registry().checkKinds()).toContain("attachment");
    expect(attachmentCheck).toMatchObject({ kind: "attachment", agentFed: true });
  });

  test("t45_check_needs_an_agent_fed_node", () => {
    const check = "{ kind: attachment, name: plan.md }";
    // a node the engine runs itself can never feed it
    const onNode = (checks: string) =>
      yaml([
        "name: p",
        "nodes:",
        "  - { slug: fix, kind: agent, prompt: fix }",
        `  - { slug: build, kind: command, command: make, checks: [${checks}] }`,
        "edges:",
        "  - { from: fix, to: build }",
        "  - { from: build, to: fix, when: failed }",
      ]);
    const onCommand = problems(onNode(check));
    expect(onCommand).toHaveLength(1);
    expect(onCommand.join("; ")).toContain(
      'node "build": a check of kind "attachment" needs a step an agent works through the tools; the engine runs this node itself',
    );
    // nor can a step with engine: its process is not a client of the tools
    const onEngine = problems(
      yaml([
        "name: p",
        "nodes:",
        `  - { slug: plan, kind: agent, prompt: plan, engine: codex, checks: [${check}] }`,
        "edges: []",
      ]),
    );
    expect(onEngine.join("; ")).toContain("a step with engine cannot feed it");
    // an agent step takes it, beside its other checks
    expect(problems(withCheck(`${check}, { kind: command, command: verify }`))).toEqual([]);
    // the rule for `result` on a command node is as it was: kept copies may hold one
    expect(validatePipeline(onNode("{ kind: result, columns: { note: text } }")).ok).toBe(true);
  });

  test("t45_no_attachment_kind_without_a_host_that_registers_it", () => {
    const source = withCheck("{ kind: attachment, name: plan.md }");
    // the built-in kinds do not have it: a host without attachments reads the pipeline as invalid
    const plain = validatePipeline(source);
    expect(plain.ok).toBe(false);
    if (!plain.ok) {
      expect(plain.code).toBe("PIPELINE_INVALID");
      expect(String(plain.issues[0]?.message)).toContain(
        'unknown check kind "attachment" (registered: command, diff, result)',
      );
    }
    // a kept copy: read with the kinds of the host that keeps it, an unknown kind without them
    expect(
      parseSnapshot(source, { extraChecks: [attachmentCheck] }).nodes[0]?.checks[0]?.kind,
    ).toBe("attachment");
    expect(() => parseSnapshot(source)).toThrow('unknown check kind "attachment"');
    // and reading one with the kind leaves the shared registry of kept copies without it
    expect(() => parseSnapshot(source)).toThrow(KodelError);
  });

  test("t45_check_adds_its_instruction", () => {
    const spec = parse(withCheck("{ kind: attachment, name: plan.md, min_lines: 10 }"));
    const begun = decide(spec, undefined, start(), 0, { registry: registry() });
    if (!begun.ok) throw begun.error;
    const step = nextStep(spec, begun.state, 0, registry());
    if (!("node" in step)) throw new Error("expected a step");
    expect(step.node.prompt).toContain("pipeline_attachment_write");
    expect(step.node.prompt).toContain('"plan.md"');
    expect(step.node.prompt).toContain("at least 10 lines");
    expect(step.node.prompt).toContain("not in the project's files");
    // the parameters of the check are not a result spec
    expect(step.node.result_spec).toBeUndefined();
  });

  test("t45_docs_list_the_attachment_check", async () => {
    const checks = (r: ReturnType<typeof registry>) =>
      docTopics(r).find((t) => t.topic === "checks")?.text ?? "";
    expect(checks(registry())).toContain("Check kind `attachment`");
    expect(checks(registry())).toContain("min_lines");
    expect(checks(defaultRegistry())).not.toContain("Check kind `attachment`");
    // the service reads the kinds of its host
    const host = { registry: registry() } as unknown as PipelineHost;
    const answer = await new PipelineService(host).docs({ topic: "checks" });
    expect(answer.ok && String(answer.text)).toContain("Check kind `attachment`");
    const bare = await new PipelineService({} as unknown as PipelineHost).docs({ topic: "checks" });
    expect(bare.ok && String(bare.text)).not.toContain("Check kind `attachment`");
  });
});

const start = (): RunEvent => ({ type: "start", runId: "r1", task: "t", specHash: "h" });

describe("t45 the check and the format of a run", () => {
  test("t45_format_1_refuses_a_pipeline_with_the_check_in_the_machine", () => {
    const plain = parse(
      yaml(["name: p", "nodes:", "  - { slug: plan, kind: agent, prompt: plan }", "edges: []"]),
    );
    const checked = parse(withCheck("{ kind: attachment, name: plan.md }"));
    expect(checkFeaturesOf(registry(), checked.nodes)).toEqual(["attachment"]);
    expect(checkFeaturesOf(registry(), plain.nodes)).toEqual([]);
    expect(unheldCheckFeature(checked, registry(), capabilitiesOf(2))).toBeUndefined();
    expect(unheldCheckFeature(checked, registry(), capabilitiesOf(1))).toBe(
      'a pipeline with a check of kind "attachment"',
    );
    expect(capabilitiesOf(1).pipelineFeatures).not.toContain("attachment");
    expect(capabilitiesOf(2).pipelineFeatures).toContain("attachment");

    const options: EngineOptions = { registry: registry() };
    const begun = decide(plain, undefined, start(), 0, options);
    if (!begun.ok) throw begun.error;
    const accept: RunEvent = {
      type: "pipeline_accepted",
      from: "h",
      to: "h2",
      source: "proposal",
      before: plain,
    };
    // format 2 takes the change
    expect(decide(checked, begun.state, accept, 1, options).ok).toBe(true);
    // format 1 refuses it before anything is written, and says how to upgrade
    const raw = JSON.parse(JSON.stringify(begun.encoded?.state)) as Record<string, unknown>;
    raw.v = 1;
    delete raw.pauses;
    for (const visit of raw.active as Record<string, unknown>[]) delete visit.spec;
    const v1: RunState = readRunState(JSON.stringify(raw), "r1");
    const refused = decide(checked, v1, accept, 1, options);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("UNSUPPORTED_FORMAT_FEATURE");
    expect(refused.error.message).toContain('a pipeline with a check of kind "attachment"');
    expect(refused.error.details).toMatchObject({ how_to_upgrade: { cli: "kodel migrate r1" } });
  });
});

describe("t45 the verdict of the check", () => {
  const SHA = "a".repeat(64);
  const version = (over: Partial<AttachmentRecord> = {}): AttachmentRecord => ({
    seq: 3,
    ts: 1,
    node: "plan",
    attempt: 1,
    name: "plan.md",
    version: 1,
    ref: attachmentRef(SHA, "plan.md"),
    type: "text",
    bytes: 10,
    lines: 3,
    sha256: SHA,
    scanned: true,
    ...over,
  });

  test("t45_verdict_fails_closed", () => {
    const params = { name: "plan.md", min_lines: 3 };
    expect(evaluateAttachment({ version: version(), state: "ok", lines: 3 }, params)).toEqual({
      passed: true,
      reason: "",
    });
    const failing: [Parameters<typeof evaluateAttachment>[0], string][] = [
      [{}, "kept no attachment"],
      [{ foreign: true }, "without the claim token"],
      [{ version: version(), state: "missing" }, "is missing"],
      [{ version: version(), state: "changed" }, "changed outside kodel"],
      // a version whose file was never looked at is not a pass
      [{ version: version() }, "is missing"],
      [{ version: version(), state: "ok", lines: 2 }, "has 2 lines, at least 3 required"],
      // the lines could not be counted: not a pass either
      [{ version: version(), state: "ok" }, "not a text"],
    ];
    for (const [facts, reason] of failing) {
      const verdict = evaluateAttachment(facts, params);
      expect(verdict.passed, reason).toBe(false);
      expect(verdict.reason, reason).toContain(reason);
    }
    // without min_lines an image passes on a verified file alone
    const image = version({ name: "shot.png", type: "png", scanned: false });
    expect(evaluateAttachment({ version: image, state: "ok" }, { name: "shot.png" }).passed).toBe(
      true,
    );
  });
});
