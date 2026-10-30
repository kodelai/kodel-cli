import { describe, expect, test } from "bun:test";
import { parsePipeline } from "@kodel-ai/pipeline-core";
import { stripAnsi, visibleLength } from "../src/tui/ansi";
import { demoSessions } from "../src/tui/demo";
import { loadSessions, type SessionSource } from "../src/tui/load";
import { reflow, stepsOf, unifiedDiff } from "../src/tui/pipelines";
import type { PipelineSource } from "../src/tui/pipes-load";
import { initialModel, type Model, render, update } from "../src/tui/view";

const SIZE = { cols: 110, rows: 30 };
const NARROW = { cols: 70, rows: 24 };

const YAML = `version: 1
name: dev
description: Plan, then build.
nodes:
  - slug: plan
    kind: agent
    prompt: |
      Write the plan
      in two lines.

      Second paragraph.
  - slug: approve
    kind: human
    prompt: "Read it."
  - slug: build
    kind: command
    command: "bun test"
    timeout: 60
edges:
  - { from: plan, to: approve }
  - { from: approve, to: build, when: approved }
  - { from: approve, to: plan, when: rejected }
  - { from: build, to: plan, when: failed }
`;

const screen = (m: Model, size = SIZE) => render(m, size).map(stripAnsi).join("\n");

function press(m: Model, keys: string[], size = SIZE): Model {
  return keys.reduce((acc, k) => update(acc, k, size), m);
}

function demo(): Model {
  return initialModel(demoSessions(Date.now()), "demo", Date.now());
}

describe("unifiedDiff", () => {
  test("two equal texts have no hunk", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toEqual([]);
  });

  test("a new file is all additions", () => {
    expect(unifiedDiff("", "a\nb\n")).toEqual(["@@ -1,0 +1,2 @@", "+a", "+b"]);
  });

  test("a replaced line shows the old one before the new one", () => {
    expect(unifiedDiff("a\nb\nc\n", "a\nx\nc\n")).toEqual([
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+x",
      " c",
    ]);
  });

  test("changes far apart are separate hunks", () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l2", "X").replace("l27", "Y");
    const hunks = unifiedDiff(before, after).filter((l) => l.startsWith("@@"));
    expect(hunks).toHaveLength(2);
  });
});

describe("stepsOf", () => {
  const steps = stepsOf(parsePipeline(YAML));

  test("a person's step is a gate", () => {
    expect(steps.map((s) => s.gate)).toEqual([false, true, false]);
  });

  test("a way back is marked, and the usual way on has no label", () => {
    expect(steps[0]?.routes).toEqual([{ to: "approve", when: "", back: false }]);
    expect(steps[1]?.routes).toEqual([
      { to: "build", when: "approved", back: false },
      { to: "plan", when: "rejected", back: true },
    ]);
    expect(steps[2]?.routes).toEqual([{ to: "plan", when: "failed", back: true }]);
  });

  test("only text a step is told or runs is kept, the prompt first", () => {
    expect(steps[0]?.params.map((p) => p.key)).toEqual(["prompt"]);
    expect(steps[2]?.params).toEqual([{ key: "command", value: "bun test" }]);
  });
});

describe("reflow", () => {
  test("the lines of a paragraph become one, and a blank line keeps the paragraphs apart", () => {
    expect(reflow("Write the plan\nin two lines.\n\nSecond.", 80)).toEqual([
      "Write the plan in two lines.",
      "",
      "Second.",
    ]);
  });

  test("a list item keeps its own line", () => {
    expect(reflow("Put:\n1. the path\n2. the questions", 80)).toEqual([
      "Put:",
      "1. the path",
      "2. the questions",
    ]);
  });
});

describe("the Pipeline screen", () => {
  test("it lists what waits for a person before the pipelines", () => {
    const text = screen(press(demo(), ["2"]));
    expect(text.indexOf("CHANGES OF A RUN")).toBeLessThan(text.indexOf("PROPOSED"));
    expect(text.indexOf("PROPOSED")).toBeLessThan(text.indexOf("PIPELINES"));
    expect(text).toContain("release");
    expect(text).toContain("docs");
  });

  test("the menu counts what waits", () => {
    expect(screen(demo())).toMatch(/2 Pipeline 2/);
  });

  test("the keys of the list select, and Enter moves into the card", () => {
    let m = press(demo(), ["2", "down"]);
    expect(m.pipe.selected).toBe("proposal:release");
    m = press(m, ["enter"]);
    expect(m.focus).toBe("card");
    expect(screen(m)).toContain("approve-release");
  });

  test("Flow shows a way back and the end of the pipeline", () => {
    const text = screen(press(demo(), ["2", "down", "down", "enter"]));
    expect(text).toContain("↩ plan");
    expect(text).toContain("the end");
  });

  test("a proposal shows the commands it would run before anything else", () => {
    const text = screen(press(demo(), ["2", "down", "enter"]));
    expect(text).toContain("NEW COMMANDS");
    expect(text).toContain("tag-release.sh");
  });

  test("Enter on a step opens its prompt, and n and p move between steps", () => {
    let m = press(demo(), ["2", "down", "down", "enter", "enter"]);
    expect(screen(m)).toContain("PROMPT");
    expect(screen(m)).toContain("step 1 of 7");
    m = press(m, ["n"]);
    expect(screen(m)).toContain("step 2 of 7");
  });

  test("only a proposal or a change has a Diff tab", () => {
    expect(screen(press(demo(), ["2", "down", "down", "enter"]))).not.toContain("Diff");
    const m = press(demo(), ["2", "enter", "right", "right", "right"]);
    expect(screen(m)).toContain("+  - slug: lint");
  });

  test("a run of the pipeline is opened on the Sessions screen", () => {
    const m = press(demo(), ["2", "down", "down", "enter", "right", "right", "enter"]);
    expect(m.section).toBe(0);
    expect(m.focus).toBe("card");
    expect(m.sessions.find((s) => s.id === m.selected)?.pipeline).toBe("dev");
  });

  test("a change of a run goes to its session with s", () => {
    const m = press(demo(), ["2", "enter", "s"]);
    expect(m.section).toBe(0);
    expect(m.sessions.find((s) => s.id === m.selected)?.need).toBe("pipeline_edit");
  });

  test("accept and drop show the command when the data is a project's", () => {
    const loaded = demoSessions(Date.now());
    const m = press(initialModel(loaded, "project", Date.now()), ["2", "down", "enter", "a"]);
    expect(m.notice).toContain("kodel pipeline proposals apply release");
    expect(press(m, ["r"]).notice).toContain("kodel pipeline proposals discard release");
  });

  test("a pipeline has nothing to accept", () => {
    const m = press(demo(), ["2", "down", "down", "enter", "a"]);
    expect(m.notice).toBe("");
  });

  test("Escape and the left key go back to the list", () => {
    const card = press(demo(), ["2", "enter"]);
    expect(press(card, ["escape"]).focus).toBe("list");
    expect(press(card, ["left"]).focus).toBe("list");
  });

  test("no pipelines says how to get one", () => {
    const m = initialModel({ sessions: [], proposals: 0, pipelines: [] }, "project", Date.now());
    expect(screen(press(m, ["2"]))).toContain("/kodel-design");
  });

  test("on a narrow terminal no line is wider than the screen", () => {
    let m = press(demo(), ["2"], NARROW);
    for (const keys of [[], ["enter"], ["right"], ["right"], ["right"]]) {
      m = press(m, keys, NARROW);
      for (const line of render(m, NARROW)) {
        expect(visibleLength(line)).toBeLessThanOrEqual(NARROW.cols);
      }
    }
  });

  test("the keys of the Sessions screen do not move its selection from here", () => {
    const before = demo();
    const m = press(before, ["2", "down", "down", "up"]);
    expect(m.selected).toBe(before.selected);
  });
});

describe("loadPipelines", () => {
  const spec = parsePipeline(YAML);
  const changed = parsePipeline(YAML.replace("bun test", "bun test --bail"));

  function source(over: Partial<PipelineSource> = {}): SessionSource & PipelineSource {
    const waiting = demoSessions(Date.now()).sessions.filter((s) => s.need === "pipeline_edit");
    return {
      runSummaries: async () =>
        waiting.map((s) => ({
          meta: { runId: s.id, pipeline: s.pipeline, task: s.title, createdAt: Date.now() },
          state: undefined,
        })),
      open: async () => undefined,
      pipelineProposals: async () => [{ name: "dev" }],
      list: async () => ({
        pipelines: [{ name: "dev", description: "Plan,\nthen build." }],
        problems: [{ file: "broken.yaml", message: "line 3: not a pipeline" }],
      }),
      resolveSource: async () => ({ spec, yaml: YAML }),
      pipelineProposal: async () => ({
        record: {
          name: "dev",
          kind: "change",
          yaml: YAML.replace("bun test", "bun test --bail"),
          summary: "bail",
        },
        spec: changed,
        current: spec,
        commands: [{ where: "build", command: "bun test --bail", isNew: true }],
      }),
      ...over,
    } as SessionSource & PipelineSource;
  }

  test("the pipelines, the broken files and the proposals each get an entry", async () => {
    const { pipelines } = await loadSessions(source(), Date.now());
    expect(pipelines?.map((p) => `${p.group}:${p.name}`)).toEqual([
      "proposal:dev",
      "pipeline:broken.yaml",
      "pipeline:dev",
    ]);
  });

  test("a proposal that changes a pipeline carries the diff against the file", async () => {
    const { pipelines } = await loadSessions(source(), Date.now());
    const proposal = pipelines?.find((p) => p.group === "proposal");
    expect(proposal?.diff).toContain('-    command: "bun test"');
    expect(proposal?.diff).toContain('+    command: "bun test --bail"');
    expect(proposal?.accept).toBe("kodel pipeline proposals apply dev");
  });

  test("a file that cannot be read says why, and has no steps", async () => {
    const { pipelines } = await loadSessions(source(), Date.now());
    const broken = pipelines?.find((p) => p.name === "broken.yaml");
    expect(broken?.problem).toBe("line 3: not a pipeline");
    expect(broken?.steps).toEqual([]);
  });

  test("a description is one line", async () => {
    const { pipelines } = await loadSessions(source(), Date.now());
    expect(pipelines?.find((p) => p.group === "pipeline" && p.name === "dev")?.description).toBe(
      "Plan, then build.",
    );
  });

  test("a proposal that cannot be read does not stop the screen", async () => {
    const { pipelines } = await loadSessions(
      source({
        pipelineProposal: async () => {
          throw new Error("damaged");
        },
      }),
      Date.now(),
    );
    expect(pipelines?.some((p) => p.group === "proposal")).toBe(false);
    expect(pipelines?.some((p) => p.name === "dev")).toBe(true);
  });

  test("a source that cannot list pipelines gives none", async () => {
    const plain: SessionSource = {
      runSummaries: async () => [],
      open: async () => undefined,
      pipelineProposals: async () => [],
    };
    expect((await loadSessions(plain, Date.now())).pipelines).toEqual([]);
  });
});
