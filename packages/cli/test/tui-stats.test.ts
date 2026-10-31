import { describe, expect, test } from "bun:test";
import {
  type AttemptReport,
  canonicalNode,
  type NodeReport,
  type PipelineSpec,
  parsePipeline,
  type RunReport,
  type RunState,
} from "@kodel-ai/pipeline-core";
import { stripAnsi, visibleLength } from "../src/tui/ansi";
import { definitionKey } from "../src/tui/definition-text";
import { demoSessions } from "../src/tui/demo";
import { demoStats } from "../src/tui/demo-stats";
import { createStatsLoader, type StatsSource } from "../src/tui/stats-load";
import { initialModel, type Model, render, takeEffects, update, withStats } from "../src/tui/view";

const SIZE = { cols: 130, rows: 34 };
const NARROW = { cols: 72, rows: 24 };

const screen = (m: Model, size = SIZE) => render(m, size).map(stripAnsi).join("\n");

function press(m: Model, keys: string[], size = SIZE): Model {
  return keys.reduce((acc, k) => update(acc, k, size), m);
}

/** The Report screen with the sample numbers already read. */
function reading(keys: string[] = [], size = SIZE): Model {
  let m = initialModel(demoSessions(Date.now()), "demo", Date.now());
  m = press(m, ["4"], size);
  m = takeEffects(m)[0];
  m = withStats(m, "dev", { status: "ready", data: demoStats("dev") });
  return press(m, keys, size);
}

describe("the Report screen asks for what it shows", () => {
  test("entering it asks for the selected pipeline, once", () => {
    const m = press(initialModel(demoSessions(Date.now()), "demo", Date.now()), ["4"]);
    expect(m.effects).toEqual([{ type: "load_stats", pipeline: "dev" }]);
    expect(screen(m)).toContain("Reading the runs");
    const [clean] = takeEffects(m);
    expect(press(clean, ["up"]).effects).toEqual([]);
  });

  test("another pipeline is asked for when it is selected", () => {
    const m = reading(["down"]);
    expect(m.rep.selected).toBe("docs");
    expect(m.effects).toEqual([{ type: "load_stats", pipeline: "docs" }]);
  });

  test("a pipeline that is only proposed has no runs to report on", () => {
    const text = screen(reading());
    expect(text).toContain("dev");
    expect(text).toContain("docs");
    expect(text).not.toContain("release");
  });

  test("a read that failed says so", () => {
    let m = reading();
    m = withStats(m, "dev", { status: "failed", error: "disk is gone" });
    expect(screen(m)).toContain("Cannot read the runs: disk is gone");
  });
});

describe("the Steps tab", () => {
  test("a row for each step, with the numbers a person looks at", () => {
    const text = screen(reading(["enter"]));
    for (const word of ["tries", "time", "back", "plan-approval", "impl", "final-approval"]) {
      expect(text).toContain(word);
    }
    expect(text).toContain("◆ plan-approval");
  });

  test("it says what was counted, and that the cost is known only for some attempts", () => {
    const text = screen(reading());
    expect(text).toContain("present definitions");
    expect(text).toMatch(/The cost is known for \d+ of \d+ attempts/);
  });

  test("a on the card counts every attempt, and a again goes back", () => {
    const all = reading(["enter", "a"]);
    expect(screen(all)).toContain("every attempt");
    expect(screen(press(all, ["a"]))).toContain("present definitions");
  });

  test("Enter reads a step: how its attempts ended and why they failed", () => {
    // impl is the third step
    const m = reading(["enter", "down", "down", "enter"]);
    const text = screen(m);
    expect(text).toContain("HOW ATTEMPTS ENDED");
    expect(text).toContain("WHY THEY FAILED");
    expect(m.rep.open).toBe(true);
  });

  test("a gate shows what people decided and the words they gave, once", () => {
    const text = screen(reading(["enter", "down", "enter"]));
    expect(text).toContain("WHAT PEOPLE DECIDED");
    expect(text).toContain("rejected");
    expect(text).not.toContain("WHY THEY FAILED");
  });

  test("n and p move between steps, Esc comes back to the table", () => {
    let m = reading(["enter", "enter"]);
    expect(screen(m)).toContain("1 of 7");
    m = press(m, ["n"]);
    expect(screen(m)).toContain("2 of 7");
    m = press(m, ["escape"]);
    expect(m.rep.open).toBe(false);
    expect(m.focus).toBe("card");
    expect(press(m, ["escape"]).focus).toBe("list");
  });

  test("a step the present definition has never run says so, and a shows the older attempts", () => {
    const data = demoStats("dev");
    const only = {
      ...data,
      current: {
        ...data.current,
        nodes: data.current.nodes.map((n) =>
          n.node === "impl" ? { ...n, runs: 0, attempts: 0, elsewhere: 30 } : n,
        ),
      },
    };
    let m = reading();
    m = withStats(m, "dev", { status: "ready", data: only });
    const text = screen(press(m, ["enter"]));
    expect(text).toContain("none on the present definition yet (30 on older ones)");
  });
});

describe("the versions of a step, under it in the table", () => {
  // impl is the third row, and the only step of the sample that changed its definition
  const onImpl = ["enter", "down", "down"];

  test("there is no tab of versions", () => {
    const text = screen(reading(["enter"]));
    expect(text).not.toContain("Versions");
    expect(text).not.toContain("Steps  ");
  });

  test("a step that changed is marked with how many definitions it had, and they are hidden", () => {
    const text = screen(reading(onImpl));
    expect(text).toMatch(/impl ▸2/);
    expect(text).not.toContain("v1");
  });

  test("the right key shows the versions with the numbers of the columns, the present one marked", () => {
    const text = screen(reading([...onImpl, "right"]));
    expect(text).toMatch(/impl ▾2/);
    const lines = text.split("\n");
    const v1 = lines.find((l) => l.includes("v1"));
    const v2 = lines.find((l) => l.includes("v2"));
    expect(v1).toMatch(/v1 \d\d-\d\d first/);
    expect(v2).toMatch(/◀ v2 \d\d-\d\d work/);
    // the same columns as the step: runs, tries, time, back
    expect(v2).toMatch(/\d+\s+\d\.\d\s+\S+\s+\S+\s+\d+%/);
  });

  test("a version is green or red where it is better or worse than the one before", () => {
    const raw = render(reading([...onImpl, "right"]), SIZE).join("\n");
    const v2 = raw.split("\n").find((l) => stripAnsi(l).includes("v2 "));
    expect(v2).toContain("\u001b[32m");
  });

  test("the left key hides them, and once more goes back to the list", () => {
    const shown = reading([...onImpl, "right"]);
    const hidden = press(shown, ["left"]);
    expect(screen(hidden)).not.toContain("v1");
    expect(hidden.focus).toBe("card");
    expect(press(hidden, ["left"]).focus).toBe("list");
  });

  test("v shows the versions of every step, and again hides them", () => {
    const shown = reading(["enter", "v"]);
    expect(screen(shown)).toContain("v2");
    expect(screen(press(shown, ["v"]))).not.toContain("v2");
  });

  test("a step that never changed says so instead of opening", () => {
    // final-approval is the sixth row
    const m = reading(["enter", "down", "down", "down", "down", "down", "right"]);
    expect(m.notice).toContain("one definition only");
    expect(m.rep.expanded).toEqual([]);
  });

  test("down goes through the versions that are shown and then on to the next step", () => {
    const shown = reading([...onImpl, "right"]);
    expect([shown.rep.row, shown.rep.ver]).toEqual([2, -1]);
    const first = press(shown, ["down"]);
    expect([first.rep.row, first.rep.ver]).toEqual([2, 0]);
    expect(screen(first)).toMatch(/❯ {3}v1/);
    const last = press(first, ["down"]);
    expect([last.rep.row, last.rep.ver]).toEqual([2, 1]);
    const next = press(last, ["down"]);
    expect([next.rep.row, next.rep.ver]).toEqual([3, -1]);
    expect(screen(next)).toMatch(/❯ ● verify/);
  });

  test("up from the step below lands on the last version that is shown", () => {
    const m = reading([...onImpl, "right", "down", "down", "down", "up"]);
    expect([m.rep.row, m.rep.ver]).toEqual([2, 1]);
    expect([press(m, ["up"]).rep.row, press(m, ["up"]).rep.ver]).toEqual([2, 0]);
    expect([press(m, ["up", "up"]).rep.ver]).toEqual([-1]);
  });

  test("hidden versions are skipped: down goes straight to the next step", () => {
    const m = reading([...onImpl, "down"]);
    expect([m.rep.row, m.rep.ver]).toEqual([3, -1]);
  });

  test("the left key on a version hides them and puts the cursor on the step", () => {
    const m = reading([...onImpl, "right", "down", "left"]);
    expect([m.rep.row, m.rep.ver]).toEqual([2, -1]);
    expect(m.rep.expanded).toEqual([]);
  });

  test("the right key on a version does nothing", () => {
    const m = reading([...onImpl, "right", "down"]);
    expect(press(m, ["right"]).rep).toEqual(m.rep);
  });

  test("the versions of a step do not change with the scope", () => {
    const current = screen(reading([...onImpl, "right"]));
    const all = screen(reading([...onImpl, "right", "a"]));
    const v1 = (t: string) =>
      t
        .split("\n")
        .find((l) => l.includes("v1"))
        ?.split("│")[1];
    expect(v1(all)).toBe(v1(current));
  });
});

describe("the detail of a version", () => {
  // impl is the third row; its versions are v1 (before) and v2 (the present one)
  const onV1 = ["enter", "down", "down", "right", "down", "enter"];
  const onV2 = ["enter", "down", "down", "right", "down", "down", "enter"];

  test("Enter on a version opens it: what changed, the numbers, and the definition", () => {
    const text = screen(reading(onV2));
    expect(text).toContain("v2");
    expect(text).toContain("the present one");
    expect(text).toContain("WHAT CHANGED SINCE v1");
    expect(text).toContain("+   Do not run the whole suite");
    expect(text).toContain("HOW ATTEMPTS ENDED");
  });

  test("the text of the definition is there, below the numbers", () => {
    const m = reading(onV2);
    const all = render(m, { cols: 130, rows: 120 }).map(stripAnsi).join("\n");
    expect(all.indexOf("HOW ATTEMPTS ENDED")).toBeLessThan(all.indexOf("THE DEFINITION"));
    expect(all).toContain("Implement the approved plan.");
    expect(all).toContain("check: diff");
  });

  test("the first version has nothing before it to be compared with", () => {
    const text = screen(reading(onV1));
    expect(text).toContain("the first definition seen");
    expect(text).not.toContain("WHAT CHANGED");
  });

  test("n and p go between the versions of the step, and stop at the ends", () => {
    let m = reading(onV1);
    expect(m.rep.ver).toBe(0);
    m = press(m, ["n"]);
    expect(m.rep.ver).toBe(1);
    expect(screen(m)).toContain("2 of 2 definitions");
    expect(press(m, ["n"]).rep.ver).toBe(1);
    expect(press(m, ["p"]).rep.ver).toBe(0);
    expect(press(m, ["p", "p"]).rep.ver).toBe(0);
  });

  test("Esc comes back to the table with the cursor on the version", () => {
    const m = press(reading(onV2), ["escape"]);
    expect(m.rep.open).toBe(false);
    expect([m.rep.row, m.rep.ver]).toEqual([2, 1]);
    expect(screen(m)).toMatch(/❯ ◀ v2/);
  });

  test("the hints say that n and p go between versions", () => {
    expect(screen(reading(onV2))).toContain("next/prev version");
    expect(screen(reading(["enter", "enter"]))).toContain("next/prev step");
  });

  test("a definition whose text is not kept says so, and the numbers stay", () => {
    let m = reading(onV2);
    m = withStats(m, "dev", {
      status: "ready",
      data: { ...demoStats("dev"), definitions: {} },
    });
    const text = render(m, { cols: 130, rows: 120 }).map(stripAnsi).join("\n");
    expect(text).toContain("The text of these definitions is not kept");
    expect(text).toContain("Its text is not kept");
    expect(text).toContain("HOW ATTEMPTS ENDED");
  });

  test("a version has the numbers of its own attempts, not the step's", () => {
    const v1 = render(reading(onV1), { cols: 130, rows: 120 }).map(stripAnsi).join("\n");
    const v2 = render(reading(onV2), { cols: 130, rows: 120 }).map(stripAnsi).join("\n");
    const attempts = (t: string) => /(\d+) attempts \(/.exec(t)?.[1];
    expect(attempts(v1)).not.toBe(attempts(v2));
  });

  test("on a narrow terminal no line is wider than the screen", () => {
    let m = reading(onV2, NARROW);
    for (const keys of [[], ["p"], ["pagedown"]]) {
      m = press(m, keys, NARROW);
      for (const line of render(m, NARROW)) {
        expect(visibleLength(line)).toBeLessThanOrEqual(NARROW.cols);
      }
    }
  });
});

describe("keys", () => {
  test("the left key goes back from the first tab to the list", () => {
    expect(reading(["enter", "left"]).focus).toBe("list");
  });

  test("the keys of the other screens do not move anything here", () => {
    const before = reading();
    const m = press(before, ["down", "up"]);
    expect(m.selected).toBe(before.selected);
  });

  test("on a narrow terminal no line is wider than the screen", () => {
    let m = reading(["enter"], NARROW);
    for (const keys of [[], ["down", "down", "enter"], ["escape", "right"]]) {
      m = press(m, keys, NARROW);
      for (const line of render(m, NARROW)) {
        expect(visibleLength(line)).toBeLessThanOrEqual(NARROW.cols);
      }
    }
  });
});

describe("createStatsLoader", () => {
  const spec: PipelineSpec = parsePipeline(
    [
      "name: p",
      "nodes:",
      "  - slug: work",
      "    kind: agent",
      "    prompt: do it",
      "edges: []",
      "",
    ].join("\n"),
  );
  const fingerprint = (text: string) => `h:${text}`;
  const forms = canonicalNode(spec, spec.nodes[0] as PipelineSpec["nodes"][number]);
  const nowDefinition = {
    work: fingerprint(forms.work),
    checks: fingerprint(forms.checks),
    routing: fingerprint(forms.routing),
  };

  const attempt = (n: number, definition: AttemptReport["definition"]): AttemptReport => ({
    attempt: n,
    seconds: 10,
    outcome: "passed",
    ...(definition ? { definition } : {}),
  });

  function report(id: string, definition: AttemptReport["definition"], status = "completed") {
    const node: NodeReport = {
      node: "work",
      gate: false,
      attempts: [attempt(1, definition)],
      seconds: 10,
    };
    return {
      runId: id,
      task: id,
      slug: id,
      status,
      total_s: 10,
      work_s: 10,
      waiting_s: 0,
      nodes: [node],
      restarts: 0,
      pauses: 0,
      feedback: 0,
      refused: 0,
      refusals: [],
      extra_attempts: 0,
      pipeline_changes: [],
      agent_decisions: [],
      checks: [],
      prompts: { not_collected: true },
    } satisfies RunReport;
  }

  function source(over: { missingSpec?: boolean; broken?: string[] } = {}) {
    const opened: string[] = [];
    const runs: [string, string, RunReport, string][] = [
      ["r1", "p", report("r1", nowDefinition), "completed"],
      ["r2", "p", report("r2", { work: "old", checks: "old", routing: "old" }), "completed"],
      ["r3", "p", report("r3", nowDefinition, "running"), "running"],
      ["r4", "other", report("r4", nowDefinition), "completed"],
      ["r5", "p", report("r5", nowDefinition), "completed"],
    ];
    const fake: StatsSource = {
      runSummaries: async () =>
        runs.map(([runId, pipeline, , status]) => ({
          meta: { runId, pipeline, createdAt: Number(runId.slice(1)) },
          state: { status } as RunState,
        })),
      open: async (runId) => {
        const found = runs.find(([id]) => id === runId);
        if (!found || over.broken?.includes(runId)) {
          return {
            report: async () => {
              opened.push(runId);
              throw new Error("damaged");
            },
          };
        }
        return {
          report: async () => {
            opened.push(runId);
            return found[2];
          },
        };
      },
      resolveSource: async () => (over.missingSpec ? undefined : { spec }),
    };
    return { fake, opened };
  }

  test("only the runs of the pipeline are read, and the unreadable ones are counted", async () => {
    const { fake, opened } = source({ broken: ["r5"] });
    const data = await createStatsLoader(fake, fingerprint)("p");
    expect(opened.sort()).toEqual(["r1", "r2", "r3", "r5"]);
    expect(data.runs).toBe(3);
    expect(data.unreadable).toBe(1);
  });

  test("the present scope keeps what ran on the definition the file has now", async () => {
    const { fake } = source();
    const data = await createStatsLoader(fake, fingerprint)("p");
    expect(data.definitionsKnown).toBe(true);
    expect(data.all.attempts.inScope).toBe(4);
    expect(data.current.attempts.inScope).toBe(3);
  });

  test("a run that is over is read once, one that is going again", async () => {
    const { fake, opened } = source();
    const load = createStatsLoader(fake, fingerprint);
    await load("p");
    opened.length = 0;
    await load("p");
    expect(opened).toEqual(["r3"]);
  });

  test("a pipeline whose file cannot be read is counted whole, and says so", async () => {
    const { fake } = source({ missingSpec: true });
    const data = await createStatsLoader(fake, fingerprint)("p");
    expect(data.definitionsKnown).toBe(false);
    expect(data.current.attempts.inScope).toBe(data.all.attempts.inScope);
  });

  test("the a key tells a person when the scope cannot change", () => {
    const m = reading(["enter"]);
    const data = demoStats("dev");
    const blind = withStats(m, "dev", {
      status: "ready",
      data: { ...data, definitionsKnown: false },
    });
    const pressed = press(blind, ["a"]);
    expect(pressed.notice).toContain("cannot be read");
    expect(pressed.rep.scope).toBe("current");
  });
});

describe("the legend", () => {
  const SHORT = { cols: 80, rows: 16 };

  test("? opens a window that says what the columns and the signs mean", () => {
    const m = reading(["enter", "?"]);
    expect(m.legend).toBe(0);
    const text = screen(m, { cols: 120, rows: 60 });
    for (const word of [
      "What the numbers mean",
      "THE COLUMNS",
      "tries",
      "back",
      "THE SIGNS",
      "THE KEYS",
    ]) {
      expect(text).toContain(word);
    }
  });

  test("the hints of the screen say where the legend is, and the window says how to close it", () => {
    expect(screen(reading(["enter"]))).toContain("? legend");
    expect(screen(reading(["enter", "?"]))).toContain("any other key closes");
  });

  test("it opens from the list as well as from the table", () => {
    expect(reading(["?"]).legend).toBe(0);
  });

  test("Esc closes it, and so does any key that does not scroll", () => {
    for (const key of ["escape", "?", "x", "enter", "q"]) {
      expect(press(reading(["enter", "?"]), [key]).legend).toBeNull();
    }
  });

  test("a key that closes it does nothing else, and the screen is as it was", () => {
    const before = reading(["enter", "down"]);
    const m = press(before, ["?", "enter"]);
    expect(m.legend).toBeNull();
    expect(m.rep).toEqual(before.rep);
    expect(m.quit).toBe(false);
  });

  test("the arrows scroll it instead of moving the cursor of the table", () => {
    const m = reading(["enter", "?"], SHORT);
    const down = press(m, ["down"], SHORT);
    expect(down.legend).toBe(1);
    expect(down.rep).toEqual(m.rep);
    expect(screen(down, SHORT)).not.toEqual(screen(m, SHORT));
    expect(press(m, ["up"], SHORT).legend).toBe(0);
  });

  test("it scrolls to the end and no further", () => {
    let m = reading(["enter", "?"], SHORT);
    for (let i = 0; i < 20; i++) m = press(m, ["pagedown"], SHORT);
    const end = m.legend ?? 0;
    expect(end).toBeGreaterThan(10);
    expect(press(m, ["down"], SHORT).legend).toBe(end);
    expect(screen(m, SHORT)).toContain("This window");
  });

  test("ctrl-c still quits", () => {
    expect(press(reading(["enter", "?"]), ["ctrl-c"]).quit).toBe(true);
  });

  test("it is part of the Report only", () => {
    const sessions = initialModel(demoSessions(Date.now()), "demo", Date.now());
    expect(press(sessions, ["?"]).legend).toBeNull();
    expect(press(sessions, ["2", "?"]).legend).toBeNull();
  });

  test("on a narrow terminal no line is wider than the screen", () => {
    const m = reading(["enter", "?", "pagedown"], NARROW);
    for (const line of render(m, NARROW)) {
      expect(visibleLength(line)).toBeLessThanOrEqual(NARROW.cols);
    }
  });

  test("the table no longer carries the explanations the window has", () => {
    const text = screen(reading(["enter"]));
    expect(text).toContain("? explains the columns");
    expect(text).not.toContain("tries: attempts per run");
  });
});

describe("the text of the definitions of a step", () => {
  const pipeline = (prompt: string) =>
    parsePipeline(
      [
        "name: p",
        "nodes:",
        "  - slug: work",
        "    kind: agent",
        `    prompt: ${prompt}`,
        "edges: []",
        "",
      ].join("\n"),
    );
  const before = pipeline("do it");
  const now = pipeline("do it, and be brief");
  const fingerprint = (text: string) => `h:${text}`;
  const definitionOf = (spec: PipelineSpec) => {
    const forms = canonicalNode(spec, spec.nodes[0] as PipelineSpec["nodes"][number]);
    return {
      work: fingerprint(forms.work),
      checks: fingerprint(forms.checks),
      routing: fingerprint(forms.routing),
    };
  };

  function report(id: string, spec: PipelineSpec): RunReport {
    const attempt: AttemptReport = {
      attempt: 1,
      seconds: 10,
      outcome: "passed",
      definition: definitionOf(spec),
    };
    return {
      runId: id,
      task: id,
      slug: id,
      status: "completed",
      total_s: 10,
      work_s: 10,
      waiting_s: 0,
      nodes: [{ node: "work", gate: false, attempts: [attempt], seconds: 10 }],
      restarts: 0,
      pauses: 0,
      feedback: 0,
      refused: 0,
      refusals: [],
      extra_attempts: 0,
      pipeline_changes: [],
      agent_decisions: [],
      checks: [],
      prompts: { not_collected: true },
    };
  }

  const runs: [string, PipelineSpec][] = [
    ["r1", before],
    ["r2", now],
    ["r3", now],
  ];

  function source(kept: boolean, calls: string[] = [], only?: string): StatsSource {
    return {
      runSummaries: async () =>
        runs
          .filter(([runId]) => only === undefined || runId === only)
          .map(([runId]) => ({
            meta: { runId, pipeline: "p", createdAt: Number(runId.slice(1)) },
            state: { status: "completed" } as RunState,
          })),
      open: async (runId) => {
        const spec = runs.find(([id]) => id === runId)?.[1] as PipelineSpec;
        return {
          report: async () => report(runId, spec),
          ...(kept
            ? {
                keptVersions: async () => {
                  calls.push(runId);
                  return [spec];
                },
              }
            : {}),
        };
      },
      resolveSource: async () => ({ spec: now }),
    };
  }

  test("each definition that a step had is found by its fingerprints, as lines", async () => {
    const data = await createStatsLoader(source(true), fingerprint)("p");
    const old = data.definitions[definitionKey("work", definitionOf(before))];
    const present = data.definitions[definitionKey("work", definitionOf(now))];
    expect(old).toContain("prompt: do it");
    expect(present).toContain("prompt: do it, and be brief");
    expect(old).toContain("kind: agent");
  });

  test("the search ends when every definition is found", async () => {
    const calls: string[] = [];
    await createStatsLoader(source(true, calls), fingerprint)("p");
    expect(calls).toEqual(["r1", "r2"]);
  });

  test("a run that is over is not asked for its kept versions twice", async () => {
    const calls: string[] = [];
    const load = createStatsLoader(source(true, calls), fingerprint);
    await load("p");
    await load("p");
    expect(calls).toEqual(["r1", "r2"]);
  });

  test("a source that cannot read the kept versions gives numbers without texts", async () => {
    const data = await createStatsLoader(source(false), fingerprint)("p");
    expect(data.definitions).toEqual({});
    expect(data.all.versions[0]?.versions).toHaveLength(2);
  });

  test("a step that never changed has no text looked up", async () => {
    const calls: string[] = [];
    const data = await createStatsLoader(source(true, calls, "r2"), fingerprint)("p");
    expect(calls).toEqual([]);
    expect(data.definitions).toEqual({});
  });
});
