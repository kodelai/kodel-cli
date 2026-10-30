import { describe, expect, test } from "bun:test";
import { parsePipeline } from "@kodel-ai/pipeline-core";
import { stripAnsi, visibleLength } from "../src/tui/ansi";
import { demoSessions } from "../src/tui/demo";
import { loadSessions, type SessionSource } from "../src/tui/load";
import { reflow, stepsOf, unifiedDiff } from "../src/tui/pipelines";
import { loadPipelines, type PipelineSource } from "../src/tui/pipes-load";
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

function demo(source: Model["source"] = "demo"): Model {
  return initialModel(demoSessions(Date.now()), source, Date.now());
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
  // In the sample the first pipeline has a change of a run waiting, the second one is a new
  // pipeline that is only proposed, the third is a plain pipeline.
  test("what waits for a person comes before the other pipelines", () => {
    const text = screen(press(demo(), ["2"]));
    expect(text.indexOf("WAITING FOR YOU")).toBeLessThan(text.indexOf("PIPELINES"));
    expect(text.indexOf("dev")).toBeLessThan(text.indexOf("docs"));
    expect(text).toContain("release");
  });

  test("the list says a pipeline is proposed and does not repeat its description", () => {
    const list = render(press(demo(), ["2"]), SIZE)
      .map((l) => stripAnsi(l).slice(0, 46))
      .join("\n");
    expect(list).toContain("proposed");
    expect(list).toContain("new");
    expect(list).not.toContain("Plan, implement and verify");
  });

  test("the menu counts the proposals that wait", () => {
    expect(screen(demo())).toMatch(/2 Pipeline 2/);
  });

  test("the keys of the list select, and Enter moves into the card", () => {
    let m = press(demo(), ["2", "down"]);
    expect(m.pipe.selected).toBe("pipeline:release");
    m = press(m, ["enter"]);
    expect(m.focus).toBe("card");
    expect(screen(m)).toContain("approve-release");
  });

  test("Flow draws the ways back as rails, and v switches to the list of routes", () => {
    const rails = press(demo(), ["2", "enter"]);
    expect(screen(rails)).toContain("◄");
    expect(screen(rails)).not.toContain("↩ plan");
    const list = press(rails, ["v"]);
    expect(screen(list)).toContain("↩ plan");
    expect(screen(list)).toContain("the end");
    expect(screen(press(list, ["v"]))).toContain("◄");
  });

  test("the view stays when another pipeline is selected", () => {
    const m = press(demo(), ["2", "enter", "v", "escape", "down"]);
    expect(m.pipe.view).toBe("list");
  });

  test("v does nothing in an opened step", () => {
    const m = press(demo(), ["2", "enter", "enter", "v"]);
    expect(m.pipe.view).toBe("rails");
  });

  test("a pipeline has only a Flow tab unless something waits", () => {
    const plain = screen(press(demo(), ["2", "down", "down", "enter"]));
    expect(plain).toContain("Flow");
    expect(plain).not.toContain("Proposed");
    expect(screen(press(demo(), ["2", "enter"]))).toContain("Proposed");
  });

  test("there is no tab of the prompt or of the runs", () => {
    const text = screen(press(demo(), ["2", "enter"]));
    expect(text).not.toContain(" Prompt ");
    expect(text).not.toContain(" Runs ");
  });

  test("Enter on a step opens it, n and p move between steps, Esc comes back", () => {
    let m = press(demo(), ["2", "enter", "enter"]);
    expect(m.pipe.open).toBe(true);
    expect(screen(m)).toContain("PROMPT");
    expect(screen(m)).toContain("step 1 of 7");
    m = press(m, ["n"]);
    expect(screen(m)).toContain("step 2 of 7");
    m = press(m, ["escape"]);
    expect(m.pipe.open).toBe(false);
    expect(m.focus).toBe("card");
    expect(screen(m)).toContain("plan-approval");
    expect(press(m, ["escape"]).focus).toBe("list");
  });

  test("an opened step says where it goes on", () => {
    const text = screen(press(demo(), ["2", "enter", "down", "enter"]));
    expect(text).toContain("THEN");
    expect(text).toContain("↩ plan");
  });

  test("the Proposed tab shows the change, and a new pipeline's commands before it", () => {
    const change = screen(press(demo(), ["2", "enter", "right"]));
    expect(change).toContain("+  - slug: lint");
    const fresh = screen(press(demo(), ["2", "down", "enter", "right"]));
    expect(fresh.indexOf("NEW COMMANDS")).toBeLessThan(fresh.indexOf("WHAT CHANGES"));
    expect(fresh).toContain("tag-release.sh");
  });

  test("a change of a run goes to its session with s", () => {
    const m = press(demo(), ["2", "enter", "right", "s"]);
    expect(m.section).toBe(0);
    expect(m.focus).toBe("card");
    expect(m.sessions.find((s) => s.id === m.selected)?.need).toBe("pipeline_edit");
  });

  test("a proposal that is not about a run has no s", () => {
    const m = press(demo(), ["2", "down", "enter", "right", "s"]);
    expect(m.section).toBe(1);
  });

  test("accept and drop show the command when the data is a project's", () => {
    const m = press(demo("project"), ["2", "down", "enter", "right", "a"]);
    expect(m.notice).toContain("kodel pipeline proposals apply release");
    expect(press(m, ["r"]).notice).toContain("kodel pipeline proposals discard release");
  });

  test("a and r do nothing outside the Proposed tab", () => {
    const m = press(demo("project"), ["2", "enter", "a"]);
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
    for (const keys of [[], ["enter"], ["enter"], ["escape", "right"]]) {
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
      pipelineProposals: async () => [{ name: "dev" }, { name: "ship" }],
      list: async () => ({
        pipelines: [{ name: "dev", description: "Plan,\nthen build." }],
        problems: [{ file: "broken.yaml", message: "line 3: not a pipeline" }],
      }),
      resolveSource: async () => ({ spec, yaml: YAML }),
      pipelineProposal: async (name: string) => ({
        record: {
          name,
          kind: name === "dev" ? "change" : "new",
          yaml: YAML.replace("bun test", "bun test --bail"),
          summary: "bail",
        },
        spec: changed,
        ...(name === "dev" ? { current: spec } : {}),
        commands: [{ where: "build", command: "bun test --bail", isNew: true }],
      }),
      ...over,
    } as SessionSource & PipelineSource;
  }

  test("a proposal of a pipeline that exists waits in that pipeline", async () => {
    const { pipelines } = await loadSessions(source(), Date.now());
    const dev = pipelines?.find((p) => p.name === "dev");
    expect(dev?.pending.map((x) => x.id)).toEqual(["proposal:dev"]);
    expect(dev?.fresh).toBeUndefined();
  });

  test("a proposal of a pipeline that does not exist is a pipeline of its own", async () => {
    const { pipelines } = await loadSessions(source(), Date.now());
    const ship = pipelines?.find((p) => p.name === "ship");
    expect(ship?.fresh).toBe(true);
    expect(ship?.pending[0]?.kind).toBe("new");
    expect(ship?.steps.length).toBeGreaterThan(0);
  });

  test("what waits is listed first, the broken files among the pipelines", async () => {
    const { pipelines } = await loadSessions(source(), Date.now());
    expect(pipelines?.map((p) => p.name)).toEqual(["dev", "ship", "broken.yaml"]);
  });

  test("a change carries the diff against the file and the commands to decide it", async () => {
    const { pipelines } = await loadSessions(source(), Date.now());
    const item = pipelines?.find((p) => p.name === "dev")?.pending[0];
    expect(item?.diff).toContain('-    command: "bun test"');
    expect(item?.diff).toContain('+    command: "bun test --bail"');
    expect(item?.accept).toBe("kodel pipeline proposals apply dev");
    expect(item?.discard).toBe("kodel pipeline proposals discard dev");
  });

  test("a change of a run waits in the pipeline of the run, with the run to go to", async () => {
    const sessions = demoSessions(Date.now()).sessions;
    const run = sessions.find((s) => s.need === "pipeline_edit");
    const pipelines = await loadPipelines(
      source({
        open: async () => ({
          pendingChange: async () => ({
            text: YAML,
            spec,
            info: {
              redo: ["nothing runs again"],
              apply: "kodel pipeline changes apply r_1",
              source: "proposal",
            },
          }),
          pinnedPipeline: async () => ({ yaml: YAML }),
        }),
      }),
      sessions,
    );
    const item = pipelines?.find((p) => p.name === run?.pipeline)?.pending.find((x) => x.runId);
    expect(item?.source).toBe("run");
    expect(item?.runId).toBe(run?.id);
    expect(item?.discard).toBe("kodel pipeline changes discard r_1");
  });

  test("a file that cannot be read says why, and has no steps", async () => {
    const { pipelines } = await loadSessions(source(), Date.now());
    const broken = pipelines?.find((p) => p.name === "broken.yaml");
    expect(broken?.problem).toBe("line 3: not a pipeline");
    expect(broken?.steps).toEqual([]);
  });

  test("a description is one line", async () => {
    const { pipelines } = await loadSessions(source(), Date.now());
    expect(pipelines?.find((p) => p.name === "dev")?.description).toBe("Plan, then build.");
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
    expect(pipelines?.flatMap((p) => p.pending)).toEqual([]);
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
