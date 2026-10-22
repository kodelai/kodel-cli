import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BASELINE_VERSION,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  defaultRegistry,
  KodelError,
  MAX_SUPPORTED_MAJOR,
  type ParseOptions,
  parsePipeline,
  type Registry,
  resolveVersion,
  validatePipeline,
} from "../src";

const doc = (...lines: string[]) => `${lines.join("\n")}\n`;

/** A small valid pipeline used as the base of most cases. */
const VALID = doc(
  "name: demo",
  "nodes:",
  "  - slug: work",
  "    kind: agent",
  "    prompt: do {{task}}",
  "  - slug: build",
  "    kind: command",
  "    command: make",
  "  - slug: approve",
  "    kind: human",
  "    prompt: ok?",
  "edges:",
  "  - { from: work, to: build }",
  "  - { from: build, to: work, when: failed }",
  "  - { from: build, to: approve }",
  "  - { from: approve, to: work, when: rejected }",
);

function problems(text: string, options?: ParseOptions) {
  const result = validatePipeline(text, options);
  if (result.ok) throw new Error("expected the pipeline to be invalid");
  return result;
}

function expectIssue(text: string, fragment: string, line?: number, options?: ParseOptions) {
  const { issues } = problems(text, options);
  const hit = issues.find((i) => i.message.includes(fragment));
  expect(
    hit?.message,
    `no issue containing "${fragment}" in ${JSON.stringify(issues)}`,
  ).toBeDefined();
  if (line !== undefined) expect(hit?.line).toBe(line);
}

describe("the reference pipeline", () => {
  const text = readFileSync(
    new URL("../../../examples/pipelines/feature.yaml", import.meta.url),
    "utf8",
  );

  test("examples/pipelines/feature.yaml is valid", () => {
    const spec = parsePipeline(text);
    expect(spec.name).toBe("feature");
    expect(spec.version).toBe("1.0.0");
    expect(spec.entry).toBe("plan");
    expect(spec.nodes.map((n) => n.slug)).toEqual([
      "plan",
      "plan-approval",
      "impl",
      "build",
      "test",
      "review",
      "e2e",
      "manual-test",
      "docs",
    ]);
    expect(spec.edges).toHaveLength(14);
  });

  test("defaults are applied and node values win", () => {
    const spec = parsePipeline(text);
    const node = (slug: string) => spec.nodes.find((n) => n.slug === slug);
    expect(node("plan")?.timeout).toBe(900);
    expect(node("build")?.timeout).toBe(600);
    expect(node("review")?.max_consecutive_failures).toBe(3);
    expect(node("review")?.max_attempts).toBe(10);
  });

  test("checks keep their kind, label and parameters", () => {
    const review = parsePipeline(text).nodes.find((n) => n.slug === "review");
    expect(review?.checks).toHaveLength(1);
    expect(review?.checks[0]?.kind).toBe("result");
    expect(review?.checks[0]?.on_fail).toBe("blocking_findings");
    const impl = parsePipeline(text).nodes.find((n) => n.slug === "impl");
    expect(impl?.checks.map((c) => c.on_fail)).toEqual(["failed", "failed"]);
  });

  test("a human node's default edge label is approved", () => {
    const spec = parsePipeline(VALID.replace("when: rejected", "when: rejected"));
    expect(spec.edges.find((e) => e.from === "approve")?.when).toBe("rejected");
    const withDefault = VALID.replace(
      "  - { from: approve, to: work, when: rejected }",
      "  - { from: approve, to: work, when: rejected }\n  - { from: approve, to: build }",
    );
    expect(
      parsePipeline(withDefault).edges.some((e) => e.from === "approve" && e.when === "approved"),
    ).toBe(true);
  });
});

describe("node kinds", () => {
  test("a field the kind does not allow is reported at its line", () => {
    const text = doc(
      "name: x",
      "nodes:",
      "  - slug: a",
      "    kind: human",
      "    prompt: p",
      "    retyr: 2",
      "edges: []",
    );
    expectIssue(text, '"retyr" is not allowed for node kind "human"', 6);
  });

  test("human nodes reject checks", () => {
    const text = doc(
      "name: x",
      "nodes:",
      "  - slug: a",
      "    kind: human",
      "    prompt: p",
      "    checks:",
      "      - { kind: command, command: ls }",
    );
    expectIssue(text, '"checks" is not allowed for node kind "human"', 6);
  });

  test("command nodes reject prompt", () => {
    const text = doc(
      "name: x",
      "nodes:",
      "  - slug: a",
      "    kind: command",
      "    command: ls",
      "    prompt: hi",
    );
    expectIssue(text, '"prompt" is not allowed for node kind "command"', 6);
  });

  test("agent nodes require a prompt", () => {
    const text = doc("name: x", "nodes:", "  - slug: a", "    kind: agent");
    expectIssue(text, 'field "prompt" is required', 3);
  });

  test("an unknown kind lists the registered ones", () => {
    const text = doc("name: x", "nodes:", "  - slug: a", "    kind: robot", "    prompt: p");
    expectIssue(text, "registered: agent, command, human", 4);
  });

  test("a missing kind is reported", () => {
    expectIssue(
      doc("name: x", "nodes:", "  - slug: a", "    prompt: p"),
      'field "kind" is required',
    );
  });

  test("attempt limits default to 3 failures in a row and 10 attempts in all", () => {
    const spec = parsePipeline(VALID);
    for (const node of spec.nodes) {
      expect(node.max_consecutive_failures).toBe(DEFAULT_MAX_CONSECUTIVE_FAILURES);
      expect(node.max_attempts).toBe(DEFAULT_MAX_ATTEMPTS);
    }
    expect([DEFAULT_MAX_CONSECUTIVE_FAILURES, DEFAULT_MAX_ATTEMPTS]).toEqual([3, 10]);
  });

  test("a node overrides the pipeline defaults, and the pipeline defaults override ours", () => {
    const text = VALID.replace(
      "name: demo\n",
      "name: demo\ndefaults:\n  max_attempts: 6\n",
    ).replace(
      "    prompt: do {{task}}\n",
      "    prompt: do {{task}}\n    max_consecutive_failures: 2\n",
    );
    const spec = parsePipeline(text);
    expect(spec.nodes[0]?.max_consecutive_failures).toBe(2);
    expect(spec.nodes[0]?.max_attempts).toBe(6);
    expect(spec.nodes[1]?.max_consecutive_failures).toBe(3);
    expect(spec.nodes[1]?.max_attempts).toBe(6);
  });

  test("failures in a row cannot exceed all attempts", () => {
    const text = VALID.replace(
      "    prompt: do {{task}}\n",
      "    prompt: do {{task}}\n    max_consecutive_failures: 5\n    max_attempts: 4\n",
    );
    expectIssue(text, "must not exceed max_attempts", 6);
  });

  test("limits must be positive integers", () => {
    expectIssue(
      VALID.replace("    prompt: do {{task}}\n", "    prompt: do {{task}}\n    max_attempts: 0\n"),
      "max_attempts",
    );
  });

  test("a node may say how long it usually takes, as a hint that is kept on the node", () => {
    const spec = parsePipeline(
      VALID.replace("    command: make\n", "    command: make\n    expected_duration: 90\n"),
    );
    expect(spec.nodes.find((n) => n.slug === "build")?.expected_duration).toBe(90);
    expect(spec.nodes.find((n) => n.slug === "work")?.expected_duration).toBeUndefined();
  });

  test("the expected duration is a positive whole number of seconds, never more than the timeout", () => {
    const withLine = (line: string) =>
      VALID.replace("    command: make\n", `    command: make\n${line}\n`);
    expectIssue(withLine("    expected_duration: 0"), "expected_duration");
    expectIssue(withLine("    expected_duration: 1.5"), "expected_duration");
    expectIssue(
      withLine("    expected_duration: 900\n    timeout: 600"),
      "must not exceed the timeout",
    );
    expect(() =>
      parsePipeline(withLine("    expected_duration: 60\n    timeout: 600")),
    ).not.toThrow();
  });

  test("a pipeline-wide timeout also bounds the expected duration", () => {
    const text = VALID.replace("nodes:", "defaults:\n  timeout: 100\nnodes:").replace(
      "    command: make\n",
      "    command: make\n    expected_duration: 500\n",
    );
    expectIssue(text, "must not exceed the timeout");
  });

  test("an agent node may ask for a fresh context, and only a boolean", () => {
    const spec = parsePipeline(
      VALID.replace(
        "    prompt: do {{task}}\n",
        "    prompt: do {{task}}\n    fresh_context: true\n",
      ),
    );
    expect(spec.nodes[0]?.params.fresh_context).toBe(true);
    expectIssue(
      VALID.replace(
        "    prompt: do {{task}}\n",
        "    prompt: do {{task}}\n    fresh_context: maybe\n",
      ),
      "fresh_context",
    );
  });

  test("slugs must be safe", () => {
    const text = doc("name: x", "nodes:", "  - slug: Bad Slug", "    kind: agent", "    prompt: p");
    expectIssue(text, "slug must be lowercase");
  });
});

describe("top level", () => {
  test("unknown top-level fields are rejected (vars is not supported yet)", () => {
    expectIssue(`${VALID}vars:\n  a: b\n`, 'field "vars" is not allowed', 17);
  });

  test("the document must be a mapping", () => {
    expectIssue("- just\n- a list\n", "must be a YAML mapping");
  });

  test("YAML syntax errors carry a line", () => {
    const { issues } = problems(doc("name: [", "nodes: []"));
    expect(issues[0]?.line).toBeDefined();
  });

  test("at least one node is required", () => {
    expectIssue(doc("name: x", "nodes: []"), "nodes");
  });

  test("an empty edges key, or none at all, means no edges", () => {
    const single = ["name: x", "nodes:", "  - slug: a", "    kind: agent", "    prompt: p"];
    expect(parsePipeline(doc(...single, "edges:")).edges).toEqual([]);
    expect(parsePipeline(doc(...single, "edges: []")).edges).toEqual([]);
    expect(parsePipeline(doc(...single)).edges).toEqual([]);
  });
});

describe("graph rules", () => {
  test("duplicate slugs", () => {
    const text = VALID.replace("slug: approve", "slug: work");
    expectIssue(text, 'duplicate node slug "work"');
  });

  test("an edge to an unknown node", () => {
    expectIssue(VALID.replace("to: build }", "to: nowhere }"), 'unknown node "nowhere"');
  });

  test("an edge label the node cannot emit", () => {
    expectIssue(VALID.replace("when: failed", "when: faild"), 'cannot emit "faild"');
  });

  test("a command node must route every failure label", () => {
    const text = VALID.replace("  - { from: build, to: work, when: failed }\n", "");
    expectIssue(text, 'can fail with "failed" but has no outgoing edge');
  });

  test("a human node must route rejection", () => {
    const text = VALID.replace("  - { from: approve, to: work, when: rejected }\n", "");
    expectIssue(text, 'can fail with "rejected" but has no outgoing edge');
  });

  test("an agent node may leave a custom failure label unrouted", () => {
    const text = VALID.replace(
      "    prompt: do {{task}}\n",
      '    prompt: do {{task}}\n    checks:\n      - { kind: diff, paths: ["src/**"], on_fail: custom }\n',
    );
    const spec = parsePipeline(text);
    expect(spec.nodes[0]?.checks[0]?.on_fail).toBe("custom");
  });

  test("an unreachable node", () => {
    const text = `${VALID.replace("edges:", "  - slug: lost\n    kind: agent\n    prompt: p\nedges:")}`;
    expectIssue(text, 'node "lost" is unreachable');
  });

  test("an edge from a node to itself", () => {
    expectIssue(VALID.replace("from: work, to: build", "from: work, to: work"), "to itself");
  });
});

describe("placeholders", () => {
  test("known placeholders and escaped ones are fine", () => {
    const text = VALID.replace(
      "prompt: do {{task}}",
      "prompt: 'do {{ task.slug }} and keep \\{{literal}}'",
    );
    expect(validatePipeline(text).ok).toBe(true);
  });

  test("unknown placeholders are rejected", () => {
    expectIssue(VALID.replace("{{task}}", "{{foo}}"), 'unknown placeholder "{{foo}}"', 5);
  });

  test("an unclosed placeholder is rejected", () => {
    expectIssue(VALID.replace("{{task}}", "{{task"), "unclosed placeholder", 5);
  });

  test("{{task}} is not allowed in a node command (shell injection)", () => {
    expectIssue(
      VALID.replace("command: make", "command: echo {{task}}"),
      '"{{task}}" is not allowed in a command',
      8,
    );
  });

  test("{{task}} is not allowed in a check command either", () => {
    const text = VALID.replace(
      "    prompt: do {{task}}\n",
      "    prompt: do {{task}}\n    checks:\n      - { kind: command, command: 'echo {{task}}' }\n",
    );
    expectIssue(text, '"{{task}}" is not allowed in a command');
  });

  test("{{run.slug}} and {{run.start_date}} are known placeholders, also in a command", () => {
    const text = VALID.replace(
      "command: make",
      "command: make plan SLUG={{run.slug}} DAY={{run.start_date}}",
    );
    expect(validatePipeline(text).ok).toBe(true);
    expectIssue(text.replace("{{run.slug}}", "{{run.nope}}"), 'unknown placeholder "{{run.nope}}"');
  });

  test("the refusal of {{task}} in a command points to the safe placeholders", () => {
    expectIssue(
      VALID.replace("command: make", "command: make {{task}}"),
      '"{{task.slug}}" or "{{run.slug}}"',
    );
  });

  test("{{task.slug}} is fine in a command, and {{task}} is fine in a prompt", () => {
    const text = VALID.replace("command: make", "command: make plan SLUG={{task.slug}}");
    expect(validatePipeline(text).ok).toBe(true);
  });
});

describe("diff check", () => {
  const withCheck = (check: string) =>
    VALID.replace(
      "    prompt: do {{task}}\n",
      `    prompt: do {{task}}\n    checks:\n      - ${check}\n`,
    );

  test("valid modes parse", () => {
    for (const mode of ["changed", "changed_only", "only", "unchanged"]) {
      expect(validatePipeline(withCheck(`{ kind: diff, paths: ["a/**"], mode: ${mode} }`)).ok).toBe(
        true,
      );
    }
  });

  test("paths are required and non-empty", () => {
    expectIssue(withCheck("{ kind: diff, paths: [] }"), "paths");
    expectIssue(withCheck("{ kind: diff }"), 'field "paths" is required');
  });

  test("an unknown mode or baseline is rejected", () => {
    expectIssue(withCheck('{ kind: diff, paths: ["a"], mode: wild }'), "mode");
    expectIssue(withCheck('{ kind: diff, paths: ["a"], since: yesterday }'), "since");
  });

  test("min_lines must not exceed max_lines", () => {
    expectIssue(
      withCheck('{ kind: diff, paths: ["a"], min_lines: 9, max_lines: 3 }'),
      "must not exceed",
    );
  });

  test("an unknown check kind lists the registered ones", () => {
    expectIssue(withCheck("{ kind: vibes }"), "registered: command, diff, result");
  });
});

describe("result check", () => {
  const columns =
    "columns: { severity: { enum: [major, minor] }, location: location, flag: boolean, note: text }";
  const withResult = (rest: string) =>
    VALID.replace(
      "    prompt: do {{task}}\n",
      `    prompt: do {{task}}\n    checks:\n      - { kind: result, ${columns}${rest} }\n`,
    );

  test("a valid fail_when parses", () => {
    expect(validatePipeline(withResult(", fail_when: { severity: [major] }")).ok).toBe(true);
    expect(validatePipeline(withResult(", fail_when: { flag: [true] }")).ok).toBe(true);
  });

  test("fail_when must refer to a known column", () => {
    expectIssue(withResult(", fail_when: { nope: [major] }"), 'unknown column "nope"');
  });

  test("fail_when enum values must exist in the column", () => {
    expectIssue(withResult(", fail_when: { severity: [blocker] }"), "is not in the enum");
  });

  test("fail_when on a boolean column takes booleans", () => {
    expectIssue(withResult(", fail_when: { flag: [major] }"), "must be true or false");
  });

  test("fail_when cannot test free-text columns", () => {
    expectIssue(withResult(", fail_when: { note: [x] }"), "can only test enum or boolean columns");
  });

  test("an unknown column type is rejected", () => {
    const text = VALID.replace(
      "    prompt: do {{task}}\n",
      "    prompt: do {{task}}\n    checks:\n      - { kind: result, columns: { a: severity } }\n",
    );
    expectIssue(text, "column type must be one of");
  });
});

describe("version", () => {
  test("resolveVersion cascades pipeline, then project, then the baseline", () => {
    expect(resolveVersion()).toBe(BASELINE_VERSION);
    expect(resolveVersion(undefined, 1)).toBe("1.0.0");
    expect(resolveVersion(undefined, "1.2.0")).toBe("1.2.0");
    expect(resolveVersion("1.0.1", "1.2.0")).toBe("1.0.1");
  });

  test("a bare number and a semver string are both accepted", () => {
    expect(parsePipeline(`version: 1\n${VALID}`).version).toBe("1.0.0");
    expect(parsePipeline(`version: "1.3.2-beta.1"\n${VALID}`).version).toBe("1.3.2-beta.1");
  });

  test("a pipeline without a version takes the project's, else the baseline", () => {
    expect(parsePipeline(VALID).version).toBe(BASELINE_VERSION);
    expect(parsePipeline(VALID, { configVersion: "1.4.0" }).version).toBe("1.4.0");
    expect(parsePipeline(`version: 1\n${VALID}`, { configVersion: "1.4.0" }).version).toBe("1.0.0");
  });

  test("a newer major is rejected, not guessed", () => {
    const tooNew = MAX_SUPPORTED_MAJOR + 1;
    expect(() => resolveVersion(tooNew)).toThrow(KodelError);
    expect(() => resolveVersion(undefined, `${tooNew}.0.0`)).toThrow(KodelError);
    try {
      resolveVersion(tooNew);
    } catch (e) {
      expect((e as KodelError).code).toBe("UNSUPPORTED_FORMAT");
    }
  });

  test("a pipeline with a newer version fails with UNSUPPORTED_FORMAT before anything else", () => {
    for (const v of ["99", '"99.0.0"']) {
      const result = validatePipeline(
        doc(`version: ${v}`, "name: x", "future_field: 1", "nodes: []"),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("UNSUPPORTED_FORMAT");
    }
  });

  test("a project version that is too new applies to pipelines without their own", () => {
    const result = validatePipeline(VALID, { configVersion: `${MAX_SUPPORTED_MAJOR + 1}.0.0` });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNSUPPORTED_FORMAT");
  });

  test("a malformed version shows the value and the accepted forms", () => {
    for (const v of [
      '"1"',
      '"x"',
      '""',
      "0",
      "1.5",
      "-1",
      "true",
      "[]",
      "null",
      '"99"',
      '"01.0.0"',
    ]) {
      expectIssue(`version: ${v}\n${VALID}`, "semver");
    }
  });

  test("the old `format` key is no longer a known field", () => {
    expectIssue(`format: 1\n${VALID}`, "format");
  });
});

describe("errors", () => {
  test("parsePipeline throws a KodelError that carries the issues", () => {
    try {
      parsePipeline(doc("name: x", "nodes:", "  - slug: a", "    kind: robot"));
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(KodelError);
      const err = e as KodelError;
      expect(err.code).toBe("PIPELINE_INVALID");
      expect(err.message).toContain("line 4");
      expect(err.toToolError().issues).toHaveLength(1);
    }
  });
});

describe("extensibility", () => {
  const text = doc(
    "name: custom",
    "nodes:",
    "  - slug: a",
    "    kind: noop",
    "    checks:",
    "      - { kind: always }",
    "edges: []",
  );

  test("kinds that are not registered are rejected", () => {
    expectIssue(text, 'unknown node kind "noop"');
  });

  test("a node kind and a check kind registered at runtime validate like built-in ones", () => {
    const registry: Registry = defaultRegistry()
      .registerNode({
        kind: "noop",
        shape: {},
        allowsChecks: true,
        requiresRoutes: false,
        automaticFailures: true,
        labels: () => ({ success: ["passed"], failure: ["failed"] }),
        begin: () => ({ needs: "agent", prompt: "do nothing" }),
      })
      .registerCheck({ kind: "always", shape: {} });
    const spec = parsePipeline(text, { registry });
    expect(spec.nodes[0]?.kind).toBe("noop");
    expect(spec.nodes[0]?.checks[0]?.kind).toBe("always");
    expect(registry.nodeKinds()).toContain("noop");
  });
});
