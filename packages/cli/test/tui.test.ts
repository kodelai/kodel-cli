import { describe, expect, test } from "bun:test";
import { stripAnsi, visibleLength } from "../src/tui/ansi";
import { demoGateDetail, demoRunningDetail, demoSessions } from "../src/tui/demo";
import type { GateDetail, Session } from "../src/tui/session";
import { formatAge } from "../src/tui/session";
import { CODE, diffKey, duration, fileAt, itemCount } from "../src/tui/tabs";
import {
  detailKey,
  hitTest,
  initialModel,
  isAnimated,
  mouseUpdate,
  ordered,
  render,
  takeEffects,
  tick,
  update,
  WIDE_COLS,
  withData,
  withDetail,
  withDiff,
} from "../src/tui/view";

const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
const plain = (lines: string[]) => lines.map(stripAnsi);
const screen = (m: ReturnType<typeof initialModel>, cols = 120, rows = 30) =>
  plain(render(m, { cols, rows })).join("\n");
const demo = () => initialModel(demoSessions(NOW), "demo", NOW);

describe("tui sessions list", () => {
  test("waiting come first, then running, then failed before the rest, the newest on top in each", () => {
    const order = ordered(demoSessions(NOW).sessions).map((s) => s.status);
    const firstRunning = order.indexOf("running");
    const firstFinished = order.findIndex(
      (s) => s === "failed" || s === "done" || s === "canceled",
    );
    expect(order.slice(0, firstRunning).every((s) => s === "waiting")).toBe(true);
    expect(order.slice(firstRunning, firstFinished).every((s) => s === "running")).toBe(true);
    expect(order[firstFinished]).toBe("failed");

    const waiting = ordered(demoSessions(NOW).sessions).filter((s) => s.status === "waiting");
    const since = waiting.map((s) => s.since);
    expect(since).toEqual([...since].sort((a, b) => b - a));
    const running = ordered(demoSessions(NOW).sessions).filter((s) => s.status === "running");
    expect(running.map((s) => s.since)).toEqual(running.map((s) => s.since).sort((a, b) => b - a));
  });

  test("the list says what is asked in plain words, never the engine's names", () => {
    const text = screen(demo());
    for (const word of ["approve", "pipeline edit", "paused", "hand edit"]) {
      expect(text).toContain(word);
    }
    for (const word of ["GATE", "CHANGE", "PROPOSAL", "ACK"]) expect(text).not.toContain(word);
  });

  test("the time column counts from the start of the wait, the run, or the end", () => {
    const text = screen(demo());
    expect(text).toContain("waiting for");
    expect(text).toContain("running for");
    expect(text).toMatch(/report-pdf-export.*1d ago/);
    // the row shows the name of the agent session, the slug only where there is none
    expect(text).toMatch(/usage and cost capture.*\b21m\b/);
    expect(formatAge(59_000)).toBe("59s");
    expect(formatAge(3_900_000)).toBe("1h05");
    expect(formatAge(26 * 3_600_000)).toBe("1d");
  });

  test("a run nobody can read goes to its own group at the bottom, not to the ones waiting for you", () => {
    const m = demo();
    const text = screen(m);
    expect(text).toContain("UNREADABLE · 1");
    expect(text.indexOf("UNREADABLE")).toBeGreaterThan(text.indexOf("FINISHED"));
    expect(ordered(m.sessions).at(-1)?.status).toBe("unreadable");
    expect(text).toContain("WAITING FOR YOU · 4");
    const unreadable = m.sessions.find((s) => s.status === "unreadable");
    const card = screen({ ...m, selected: unreadable?.id ?? "" });
    expect(card).toContain("Nothing to decide here.");
    expect(update({ ...m, selected: unreadable?.id ?? "" }, "a").confirm).toBeNull();
  });

  test("finished runs: done, failed and canceled have different marks", () => {
    const text = screen(demo());
    expect(text).toMatch(/✓ task-key-format/);
    expect(text).toMatch(/✗ report-pdf-export/);
    expect(text).toMatch(/⊘ old-experiment/);
  });

  test("a running session moves: the spinner turns and the agent's dot blinks", () => {
    const m = demo();
    const raw = (model: typeof m) => render(model, { cols: 120, rows: 30 }).join("\n");
    let next = tick(m, NOW);
    expect(raw(next)).not.toBe(raw(m));
    let blinked = m;
    for (let i = 0; i < 5; i++) blinked = tick(blinked, NOW);
    expect(raw(blinked)).not.toBe(raw(m));
    next = m;
    expect(isAnimated(next)).toBe(true);
  });

  test("a quiet session does not move and says how long it has been quiet", () => {
    const loaded = demoSessions(NOW);
    const quiet = loaded.sessions.filter((s) => s.status === "running" && s.activity === "quiet");
    const m = initialModel({ sessions: quiet, proposals: 0 }, "demo", NOW);
    expect(isAnimated(m)).toBe(false);
    expect(screen(m)).toContain("quiet 12m");
  });

  test("every line fits the width at wide, narrow and tiny sizes", () => {
    for (const size of [
      { cols: 120, rows: 32 },
      { cols: WIDE_COLS, rows: 24 },
      { cols: 70, rows: 20 },
      { cols: 40, rows: 12 },
    ]) {
      const lines = render(demo(), size);
      expect(lines.length).toBeLessThanOrEqual(size.rows);
      for (const line of lines) expect(visibleLength(line)).toBe(size.cols);
    }
  });

  test("wide terminal shows list and card together, narrow shows one at a time", () => {
    const m = demo();
    expect(screen(m, 120)).toContain("JOURNAL");
    const list = screen(m, 70);
    expect(list).toContain("WAITING FOR YOU");
    expect(list).not.toContain("JOURNAL");
    const card = screen(update(m, "enter"), 70);
    expect(card).toContain("JOURNAL");
    expect(card).not.toContain("WAITING FOR YOU");
  });

  test("the card of a waiting run says what is asked, what comes after, and the command", () => {
    let m = demo();
    const edit = demoSessions(NOW).sessions.find((s) => s.need === "pipeline_edit");
    m = { ...m, selected: edit?.id ?? "" };
    const text = screen(m);
    expect(text).toContain("The agent proposes to change this run's pipeline");
    expect(text).toContain("After that: approve «review»");
    expect(text).toContain("kodel pipeline changes apply");
  });

  test("the card of a failed run says why and that nothing is left to decide", () => {
    const failed = demoSessions(NOW).sessions.find((s) => s.status === "failed");
    const m = { ...demo(), selected: failed?.id ?? "" };
    const text = screen(m);
    expect(text).toContain("nothing handles that");
    expect(text).toContain("add a route");
    expect(update(m, "a").confirm).toBeNull();
  });

  test("in a project, a and r point to the command and decide nothing", () => {
    const gate = demoSessions(NOW).sessions.find((s) => s.need === "approve");
    const m = { ...initialModel(demoSessions(NOW), "project", NOW), selected: gate?.id ?? "" };
    const next = update(m, "a");
    expect(next.confirm).toBeNull();
    expect(next.notice).toContain("kodel gate approve");
    expect(next.sessions).toEqual(m.sessions);
  });

  test("on sample data a decision needs a confirmation and moves the session out of the waiting group", () => {
    const gate = demoSessions(NOW).sessions.find((s) => s.need === "approve");
    const id = gate?.id ?? "";
    let m = { ...demo(), selected: id };
    m = update(m, "a");
    expect(m.confirm).toBe("a");
    expect(update(m, "n").confirm).toBeNull();
    m = update(m, "y");
    expect(m.sessions.find((s) => s.id === id)?.status).toBe("running");
    expect(
      ordered(m.sessions)
        .filter((s) => s.status === "waiting")
        .map((s) => s.id),
    ).not.toContain(id);
  });

  test("a key a need does not have does nothing", () => {
    const hand = demoSessions(NOW).sessions.find((s) => s.need === "hand_edit");
    const m = { ...demo(), selected: hand?.id ?? "" };
    expect(update(m, "r").confirm).toBeNull();
  });

  test("new data keeps the selection on the same run", () => {
    const m = { ...demo(), selected: "r_1kd9q22vb" };
    const fresh = demoSessions(NOW + 5000);
    expect(withData(m, fresh, NOW + 5000).selected).toBe("r_1kd9q22vb");
    const without = {
      sessions: fresh.sessions.filter((s) => s.id !== "r_1kd9q22vb"),
      proposals: 0,
    };
    expect(withData(m, without, NOW).selected).toBe(ordered(without.sessions)[0]?.id ?? "");
  });

  test("proposals show on the menu and as a hint, not as a row", () => {
    const m = demo();
    // The proposal and the change of a run's pipeline both wait for a person.
    expect(screen(m)).toContain("2 Pipeline 2");
    expect(screen(m)).toContain("1 pipeline proposal wait on 2");
    expect(m.sessions.some((s) => s.title.includes("release"))).toBe(false);
  });

  test("a project without runs says how to start one", () => {
    const m = initialModel({ sessions: [], proposals: 0 }, "project", NOW);
    const text = screen(m);
    expect(text).toContain("No runs yet.");
    expect(text).toContain("/kodel-run");
  });
});

describe("tui mouse", () => {
  const WIDE = { cols: 120, rows: 30 };
  const NARROW = { cols: 70, rows: 30 };
  const on = () => ({ ...demo(), mouse: true });
  const press = (x: number, y: number) => ({
    type: "mouse" as const,
    action: "press" as const,
    x,
    y,
  });
  const wheel = (action: "wheel_up" | "wheel_down") => ({
    type: "mouse" as const,
    action,
    x: 5,
    y: 5,
  });
  /** The 1-based row of the screen where `text` is shown. */
  const rowOf = (m: ReturnType<typeof demo>, size: { cols: number; rows: number }, text: string) =>
    plain(render(m, size)).findIndex((l) => l.includes(text)) + 1;

  test("`m` turns the mouse on and off, says how to select text, and shows the state", () => {
    let m = demo();
    expect(m.mouse).toBe(false);
    expect(screen(m)).toContain("m mouse off");
    m = update(m, "m");
    expect(m.mouse).toBe(true);
    expect(m.notice).toContain("Shift");
    expect(screen({ ...m, notice: "" })).toContain("m mouse on");
    expect(update(m, "m").mouse).toBe(false);
  });

  test("with the mouse off, clicks and the wheel do nothing", () => {
    const m = demo();
    const y = rowOf(m, WIDE, "fix-wait-timeout");
    expect(mouseUpdate(m, WIDE, press(3, y))).toBe(m);
    expect(mouseUpdate(m, WIDE, wheel("wheel_down"))).toBe(m);
  });

  test("a click on a row selects that session", () => {
    const m = on();
    const y = rowOf(m, WIDE, "fix-wait-timeout");
    const hit = hitTest(m, WIDE, 3, y);
    expect(hit).toEqual({ kind: "session", id: "r_1kd9q22vb" });
    expect(mouseUpdate(m, WIDE, press(3, y)).selected).toBe("r_1kd9q22vb");
  });

  test("a click on a heading, a gap or below the list selects nothing, and one in the card is the card's", () => {
    const m = on();
    const heading = rowOf(m, WIDE, "WAITING FOR YOU");
    expect(hitTest(m, WIDE, 3, heading)).toBeUndefined();
    expect(hitTest(m, WIDE, 3, heading + 5)).toBeUndefined();
    const y = rowOf(m, WIDE, "fix-wait-timeout");
    expect(hitTest(m, WIDE, 100, y)).toEqual({ kind: "card" });
    expect(hitTest(m, WIDE, 3, 2)).toBeUndefined();
    expect(hitTest(m, WIDE, 3, WIDE.rows)).toBeUndefined();
  });

  test("on a narrow screen the second click on a row opens its card, and a click in the card changes nothing", () => {
    let m = on();
    const y = rowOf(m, NARROW, "fix-wait-timeout");
    m = mouseUpdate(m, NARROW, press(5, y));
    expect(m.selected).toBe("r_1kd9q22vb");
    expect(m.focus).toBe("list");
    m = mouseUpdate(m, NARROW, press(5, y));
    expect(m.focus).toBe("card");
    expect(mouseUpdate(m, NARROW, press(5, y))).toEqual(m);
  });

  test("a click on the menu switches the section, with the counts in the badge taken into account", () => {
    const m = on();
    const line = plain(render(m, WIDE))[0] ?? "";
    const pipeline = line.indexOf("2 Pipeline") + 1;
    expect(mouseUpdate(m, WIDE, press(pipeline + 2, 1)).section).toBe(1);
    const tasks = line.indexOf("3 Tasks") + 1;
    expect(mouseUpdate(m, WIDE, press(tasks, 1)).section).toBe(2);
    expect(hitTest(m, WIDE, 2, 1)).toBeUndefined(); // the name on the left is not a button
  });

  test("the wheel moves the selection down and up, and stops at the ends", () => {
    let m = on();
    const first = ordered(m.sessions)[0]?.id;
    expect(m.selected).toBe(first ?? "");
    m = mouseUpdate(m, WIDE, wheel("wheel_up"));
    expect(m.selected).toBe(first ?? "");
    m = mouseUpdate(m, WIDE, wheel("wheel_down"));
    expect(m.selected).toBe(ordered(m.sessions)[1]?.id ?? "");
    const last = ordered(m.sessions).at(-1)?.id ?? "";
    for (let i = 0; i < 40; i++) m = mouseUpdate(m, WIDE, wheel("wheel_down"));
    expect(m.selected).toBe(last);
  });

  test("the wheel over a card scrolls the card, not the selection; other sections are left alone", () => {
    const gate = demoSessions(NOW).sessions.find((s) => s.need === "approve");
    const key = detailKey(gate as Session);
    const detail = demoGateDetail(gate?.id ?? "", NOW) as GateDetail;
    const base = { ...withDetail({ ...on(), selected: gate?.id ?? "" }, key, detail), tab: 4 };
    const small = { cols: 70, rows: 14 };
    const card = { ...base, focus: "card" as const };
    const scrolled = mouseUpdate(card, small, wheel("wheel_down"));
    expect(scrolled.cardScroll).toBeGreaterThan(0);
    expect(scrolled.selected).toBe(card.selected);
    const wide = { cols: 120, rows: 14 };
    expect(mouseUpdate(base, wide, { ...wheel("wheel_down"), x: 100 }).cardScroll).toBeGreaterThan(
      0,
    );
    expect(mouseUpdate(base, wide, { ...wheel("wheel_down"), x: 5 }).cardScroll).toBe(0);
    const other = { ...on(), section: 1 };
    expect(mouseUpdate(other, WIDE, wheel("wheel_down"))).toBe(other);
  });

  test("while a decision waits for y or n, the mouse does nothing", () => {
    const gate = demoSessions(NOW).sessions.find((s) => s.need === "approve");
    const asked = update({ ...on(), selected: gate?.id ?? "" }, "a");
    expect(asked.confirm).toBe("a");
    const y = rowOf(asked, WIDE, "fix-wait-timeout");
    expect(mouseUpdate(asked, WIDE, press(3, y))).toBe(asked);
    expect(mouseUpdate(asked, WIDE, wheel("wheel_down"))).toBe(asked);
  });

  test("a click never decides: the action line of the card is text, not a button", () => {
    const gate = demoSessions(NOW).sessions.find((s) => s.need === "approve");
    const m = { ...on(), selected: gate?.id ?? "" };
    const y = rowOf(m, WIDE, "a approve");
    const x = (plain(render(m, WIDE))[y - 1] ?? "").indexOf("a approve") + 1;
    expect(mouseUpdate(m, WIDE, press(x, y)).confirm).toBeNull();
    expect(mouseUpdate(m, WIDE, press(x, y)).sessions).toEqual(m.sessions);
  });

  test("a list that scrolls: a click lands on the row that is shown, not on the one at that index", () => {
    const sessions: Session[] = Array.from({ length: 60 }, (_, i) => ({
      id: `r_${String(i).padStart(3, "0")}`,
      title: `finished-run-${String(i).padStart(2, "0")}`,
      pipeline: "dev",
      status: "done",
      step: "done",
      since: NOW - (i + 1) * 3_600_000,
      steps: [],
      log: [],
    }));
    let m = { ...initialModel({ sessions, proposals: 0 }, "project", NOW), mouse: true };
    for (let i = 0; i < 45; i++) m = mouseUpdate(m, WIDE, wheel("wheel_down"));
    const y = rowOf(m, WIDE, "finished-run-40");
    expect(y).toBeGreaterThan(0);
    const clicked = mouseUpdate(m, WIDE, press(3, y));
    expect(clicked.selected).toBe(sessions.find((s) => s.title === "finished-run-40")?.id ?? "");
  });
});

describe("tui card of a run waiting for approval", () => {
  const SIZE = { cols: 120, rows: 44 };
  const SMALL = { cols: 120, rows: 16 };
  const gate = () => demoSessions(NOW).sessions.find((s) => s.need === "approve") as Session;
  const detail = () => demoGateDetail(gate().id, NOW) as GateDetail;
  const withCard = (d: GateDetail = detail()) => {
    const g = gate();
    return withDetail({ ...demo(), selected: g.id }, detailKey(g), d);
  };
  const press = (
    m: ReturnType<typeof demo>,
    size: { cols: number; rows: number },
    ...keys: string[]
  ) => keys.reduce((acc, k) => update(acc, k, size), m);
  const text = (m: ReturnType<typeof demo>, size = SIZE) => plain(render(m, size)).join("\n");
  const n = (count: number, key: string) => Array<string>(count).fill(key);
  const TAB = { report: 0, code: 1, steps: 2, comments: 3, log: 4 };
  /** The keys that go to a tab: Enter on the list, then the tabs to the right. */
  const toTab = (tab: number) => ["enter", ...n(tab, "right")];

  test("the band on top gives the name, where the run stands and its numbers", () => {
    const out = text(withCard());
    expect(out).toContain("╭");
    expect(out).toContain("capture-usage-cost");
    expect(out).toContain("r_0mvo6g4mi · dev");
    expect(out).toContain("gate 2 of 2 · final-approval");
    expect(out).toContain("⏱ 1h32 work · 30m waiting");
    expect(out).toContain("8/9 steps");
    expect(out).toContain("⟳ 2 retries");
    expect(out).toContain("✓ 6/6 checks");
    expect(out).toContain("± 5 files · 379 lines");
    expect(out).toContain("⛁ 412k tokens");
  });

  test("the band says when a number is not known and when something is wrong", () => {
    const d = detail();
    const none = text(
      withCard({ ...d, metrics: { ...d.metrics, tokens: undefined } as GateDetail["metrics"] }),
    );
    expect(none).toContain("⛁ —");
    const approx = text(
      withCard({ ...d, metrics: { ...d.metrics, tokens: { total: 5000, approx: true } } }),
    );
    expect(approx).toContain("⛁ ~5.0k tokens");
    const late = text(withCard({ ...d, changedAfterChecks: ["a.ts", "b.ts"] }));
    expect(late).toContain("⚠ 2 files changed after the checks");
    const red = text(withCard({ ...d, metrics: { ...d.metrics, checksPassed: 5 } }));
    expect(red).toContain("✗ 5/6 checks");
  });

  test("the tabs are in the order a gate is read, with what is behind each", () => {
    const out = text(withCard());
    const strip = out.split("\n").find((l) => l.includes("Comments")) ?? "";
    const at = (name: string) => strip.indexOf(name);
    expect(at("Report")).toBeGreaterThan(-1);
    expect(at("Code 5")).toBeGreaterThan(at("Report"));
    expect(at("Steps 10")).toBeGreaterThan(at("Code"));
    expect(at("Comments 0")).toBeGreaterThan(at("Steps"));
    expect(at("Log 12")).toBeGreaterThan(at("Comments"));
  });

  test("it opens on the question, and straight after it the agent's report, whole", () => {
    const out = text(press(withCard(), SIZE, "enter"));
    expect(out).toContain("❯ Look at the diff and try the change.");
    expect(out).not.toContain("ASKED");
    expect(out).toContain("THE AGENT'S REPORT · written 20m ago");
    expect(out.indexOf("THE AGENT'S REPORT")).toBeGreaterThan(out.indexOf("❯"));
    const lines = plain(render(press(withCard(), SIZE, "enter"), SIZE));
    const at = lines.findIndex((l) => l.includes("❯"));
    expect(lines[at + 1]).toContain("with what is wrong.".slice(0, 4)); // the question wraps
    expect(lines.slice(at, at + 5).some((l) => l.includes("THE AGENT'S REPORT"))).toBe(true);
    expect(out).toContain("Done: `kodel status` prints one short line per run");
    expect(out).toContain("- `packages/cli/src/format.ts`: a new `shortLine(run, max)`");
    expect(out).toContain("Not done: the plan asked for a test");
    expect(out).toContain("Approve to finish, or reject with what is wrong.");
    expect(out).not.toContain("**");
    expect(out).not.toContain("## ");
  });

  test("what can be done is on the bottom line, not between the question and the report", () => {
    const lines = plain(render(press(withCard(), SIZE, "enter"), SIZE));
    expect(lines.some((l) => l.includes("c add a comment"))).toBe(false);
    const footer = lines.at(-1) ?? "";
    expect(footer).toContain("a approve");
    expect(footer).toContain("r reject");
    expect(footer).toContain("c comment");
  });

  test("a line under the tabs sets them apart from what is under them", () => {
    const lines = plain(render(press(withCard(), SIZE, "enter"), SIZE));
    const tabs = lines.findIndex((l) => l.includes("Report") && l.includes("Comments"));
    expect(tabs).toBeGreaterThan(0);
    expect(lines[tabs + 1]).toMatch(/─{40,}/);
    expect(lines[tabs + 2]).toContain("❯");
  });

  test("the instructions the pipeline gives the agent for its message are not the person's business, unless asked for", () => {
    const d = { ...detail(), instructions: "The message must contain the path of the worktree." };
    const footer = (m: ReturnType<typeof withCard>) => plain(render(m, SIZE)).at(-1) ?? "";
    let m = press(withCard(d), SIZE, "enter");
    expect(text(m)).not.toContain("path of the worktree");
    expect(footer(m)).toContain("i instructions");
    m = press(m, SIZE, "i");
    expect(text(m)).toContain("INSTRUCTIONS THE AGENT WAS GIVEN FOR ITS MESSAGE");
    expect(text(m)).toContain("path of the worktree");
    expect(text(press(m, SIZE, "i"))).not.toContain("path of the worktree");
    // nothing to show, nothing to toggle
    expect(footer(press(withCard(), SIZE, "enter"))).not.toContain("i instructions");
    expect(press(press(withCard(), SIZE, "enter"), SIZE, "i").instructions).toBe(false);
  });

  test("a report that is only a step's summary says which step it is from, and no report says so", () => {
    const d = detail();
    const fromJournal = text(
      press(
        withCard({ ...d, report: { text: "I did it.", ts: 0, from: "journal", step: "review" } }),
        SIZE,
        "enter",
      ),
    );
    expect(fromJournal).toContain("THE AGENT'S REPORT · from step «review»");
    expect(fromJournal).not.toContain("only the summary");
    expect(fromJournal).not.toContain("not checked");
    expect(fromJournal).toContain("I did it.");
    const none = text(press(withCard({ ...d, report: undefined }), SIZE, "enter"));
    expect(none).toContain("THE AGENT'S REPORT");
    expect(none).toContain("Not found.");
  });

  test("a long report scrolls", () => {
    const long = Array.from({ length: 80 }, (_, i) => `Line ${i} of the report.`).join("\n");
    let m = press(
      withCard({ ...detail(), report: { text: long, ts: Date.now(), from: "log" } }),
      SMALL,
      "enter",
    );
    expect(text(m, SMALL)).toContain("▼ PgDn for more");
    m = press(m, SMALL, "pagedown");
    expect(m.cardScroll).toBeGreaterThan(0);
    expect(text(m, SMALL)).toContain("▲ PgUp for earlier");
  });

  test("Code lists the files with the comments on each, and Enter opens one and asks for its diff once", () => {
    const d = {
      ...detail(),
      comments: [{ severity: "major", location: "packages/cli/src/format.ts:9", description: "x" }],
    };
    let m = press(withCard(d), SIZE, ...toTab(TAB.code));
    const list = text(m);
    expect(list).toContain("5 files · 379 lines · Enter opens a file");
    expect(list).toContain("▸ packages/cli/test/cli.test.ts");
    expect(list).toMatch(/packages\/cli\/src\/format\.ts\s+61 ✎1/);
    m = press(m, SIZE, "down", "down", "enter");
    expect(m.open).toBe(true);
    expect(m.effects).toEqual([
      { type: "load_diff", runId: gate().id, path: "packages/cli/src/format.ts" },
    ]);
    expect(text(m)).toContain("Code › packages/cli/src/format.ts");
    expect(text(m)).toContain("Reading the diff…");
    const [clean] = takeEffects(m);
    const read = withDiff(clean, diffKey(gate().id, "packages/cli/src/format.ts"), {
      kind: "text",
      text: "@@ -1,2 +1,3 @@\n unchanged\n-old\n+new",
      truncated: false,
    });
    const shown = render(read, SIZE).join("\n");
    expect(stripAnsi(shown)).toMatch(/\+ new/);
    expect(stripAnsi(shown)).toMatch(/- old/);
    expect(shown).toContain("\u001b[32m"); // added lines are green
    expect(shown).toContain("\u001b[31m"); // removed ones red
    // The same file again asks for nothing; another file asks for its own.
    const next = press(read, SIZE, "n");
    expect(next.effects).toEqual([
      { type: "load_diff", runId: gate().id, path: "docs/plans/make-status-readable.md" },
    ]);
    expect(press(takeEffects(next)[0], SIZE, "p").effects).toEqual([]);
    expect(press(read, SIZE, "escape").open).toBe(false);
  });

  test("in a diff the arrows move a cursor over the code, [ and ] jump between hunks, g and G go to the ends", () => {
    const diff = {
      kind: "text" as const,
      truncated: false,
      text: "@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n@@ -20,2 +20,3 @@\n x\n+y\n z\n",
    };
    const path = "packages/cli/src/format.ts";
    const opened = withDiff(
      press(withCard(), SIZE, ...toTab(TAB.code), "down", "down", "enter"),
      diffKey(gate().id, path),
      diff,
    );
    expect(opened.line).toBe(-1);
    expect(text(opened)).toMatch(/▸\s+1\s+one/);
    let m = press(opened, SIZE, "down", "down");
    expect(m.line).toBe(3); // "+2", over the "-two"
    expect(text(m)).toMatch(/▸\s+2 \+ 2/);
    m = press(m, SIZE, "]");
    expect(text(m)).toMatch(/▸\s+20\s+x/);
    m = press(m, SIZE, "[");
    expect(text(m)).toMatch(/▸\s+1\s+one/);
    expect(text(press(m, SIZE, "G"))).toMatch(/▸\s+22\s+z/);
    expect(text(press(press(m, SIZE, "G"), SIZE, "g"))).toMatch(/▸\s+1\s+one/);
    expect(press(m, SIZE, "pagedown").line).toBe(press(m, SIZE, "G").line);
    expect(m.cardScroll).toBe(0); // the cursor moved, the page did not
  });

  test("c in a diff comments on the line the cursor is on; on a removed line it says so", () => {
    const diff = {
      kind: "text" as const,
      truncated: false,
      text: "@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n",
    };
    const path = "packages/cli/src/format.ts";
    const opened = withDiff(
      press(withCard(), SIZE, ...toTab(TAB.code), "down", "down", "enter"),
      diffKey(gate().id, path),
      diff,
    );
    expect(press(opened, SIZE, "c").input?.place).toBe(`${path}:1`);
    expect(press(opened, SIZE, "down", "c").input?.place).toBe(`${path}:2 (removed line)`);
    expect(press(opened, SIZE, "down", "down", "c").input?.place).toBe(`${path}:2`);
  });

  test("another file starts at its first line again", () => {
    const diff = { kind: "text" as const, truncated: false, text: "@@ -1,2 +1,2 @@\n a\n b\n" };
    let m = withDiff(
      press(withCard(), SIZE, ...toTab(TAB.code), "down", "down", "enter"),
      diffKey(gate().id, "packages/cli/src/format.ts"),
      diff,
    );
    m = press(m, SIZE, "down");
    expect(m.line).toBeGreaterThan(0);
    m = press(m, SIZE, "n");
    expect(m.line).toBe(-1);
  });

  test("a diff that cannot be read says why, and one that is cut says so", () => {
    const path = "packages/cli/test/cli.test.ts";
    const base = press(withCard(), SIZE, ...toTab(TAB.code), "enter");
    const key = diffKey(gate().id, path);
    expect(text(withDiff(base, key, { kind: "error", message: "git failed" }))).toContain(
      "Cannot read the diff: git failed",
    );
    expect(text(withDiff(base, key, { kind: "missing" }))).toContain("No diff to show");
    expect(text(withDiff(base, key, { kind: "text", text: "+a", truncated: true }))).toContain(
      "the diff is cut here",
    );
  });

  test("Steps is the run's calls in the order they happened: repeats after a failure are marked", () => {
    const out = text(press(withCard(), SIZE, ...toTab(TAB.steps)));
    expect(out).toContain("10 entries into steps · Enter opens one");
    expect(out).toMatch(/✗\s+impl\s+agent\s+4m00\s+The diff check: 1438 line/);
    expect(out).toMatch(/✓ ↺ impl #2\s+agent\s+3m00/);
    expect(out).toMatch(/✗\s+test\s+command\s+1m10\s+1 test failed/);
    expect(out).toMatch(/✓ ↺ test #2\s+command\s+1m26/);
    expect(out).toMatch(/✓\s+plan-approval\s+human\s+9m00\s+approved/);
    expect(out).toMatch(/✓\s+review\s+agent\s+20\.0s\s+3 findings/);
    expect(out).toMatch(/◐\s+final-approval\s+human\s+21m00\s+waiting for you/);
  });

  test("a step opens on its result; ← and → show its changes and its log; n and p walk the steps", () => {
    let m = press(withCard(), SIZE, ...toTab(TAB.steps), ...n(5, "down"), "enter");
    let out = text(m);
    expect(out).toContain("Steps › test");
    expect(out).toContain("Result  Changes  Log");
    expect(out).toContain("1 test failed: t40_wait_timeout_reports");
    expect(out).toContain("exit 1");
    m = press(m, SIZE, "right");
    out = text(m);
    expect(out).toContain("not recorded for it yet");
    m = press(m, SIZE, "right");
    out = text(m);
    expect(out).toContain("The agent did nothing in this step.");
    m = press(m, SIZE, "n");
    expect(text(m)).toContain("Steps › test #2");
    expect(text(m)).toContain("The agent did nothing in this step.");
    m = press(m, SIZE, "escape");
    expect(m.open).toBe(false);
    expect(m.tab).toBe(TAB.steps);
  });

  test("the findings are inside the review step, in full, marked as the agent's", () => {
    const m = press(withCard(), SIZE, ...toTab(TAB.steps), ...n(8, "down"), "enter");
    const out = text(m);
    expect(out).toContain("Steps › review");
    expect(out).toContain("Findings (the agent's, complete): 2 minor · 1 info");
    expect(out).toContain("packages/cli/test/cli.test.ts:296");
    expect(out).toContain("coverage gap");
    // and not on the first screen
    expect(text(press(withCard(), SIZE, "enter"))).not.toContain("Findings");
  });

  test("what the agent said about a step is marked as not verified; a person's decision shows its reason", () => {
    const d = detail();
    const visits = d.visits.map((v) =>
      v.slug === "plan-approval"
        ? {
            ...v,
            attempt: {
              ...v.attempt,
              decision: { decision: "rejected", reason: "no tests in the plan" },
            },
          }
        : v,
    );
    const base = withCard({ ...d, visits });
    const impl = text(press(base, SIZE, ...toTab(TAB.steps), ...n(3, "down"), "enter"));
    expect(impl).toContain("The agent says (not verified):");
    expect(impl).toContain("Split the change: the table printer stays as it was.");
    const human = text(press(base, SIZE, ...toTab(TAB.steps), "down", "enter"));
    expect(human).toContain("You: rejected");
    expect(human).toContain("no tests in the plan");
  });

  test("a step that has not started says so", () => {
    const d = detail();
    const next = {
      ...d.visits[0],
      slug: "release",
      kind: "command",
      state: "pending" as const,
      attempt: { n: 0, checks: [], log: [] },
    } as GateDetail["visits"][number];
    const out = text(
      press(
        withCard({ ...d, visits: [...d.visits, next] }),
        SIZE,
        ...toTab(TAB.steps),
        ...n(10, "down"),
        "enter",
      ),
    );
    expect(out).toContain("This step has not started yet.");
  });

  test("c opens a comment about what is on the screen: the file, the step, or the gate", () => {
    const code = press(withCard(), SIZE, ...toTab(TAB.code), "down", "c");
    expect(code.input).toEqual({ text: "", severity: "major", place: "packages/cli/src/cli.ts" });
    const step = press(withCard(), SIZE, ...toTab(TAB.steps), ...n(4, "down"), "c");
    expect(step.input?.place).toBe("verify");
    const report = press(withCard(), SIZE, "enter", "c");
    expect(report.input?.place).toBe("final-approval");
    const open = press(withCard(), SIZE, ...toTab(TAB.code), "enter", "n", "c");
    expect(open.input?.place).toBe("packages/cli/src/cli.ts");
  });

  test("typing a comment: text goes in, backspace takes it out, Tab changes the severity, Esc leaves, Enter saves", () => {
    let m = press(withCard(), SIZE, ...toTab(TAB.code), "c");
    expect(text(m)).toContain("cli.test.ts [major]: ");
    m = press(m, SIZE, ..."Not needed!".split(""));
    m = press(
      m,
      SIZE,
      "backspace",
      "backspace",
      "backspace",
      "backspace",
      "backspace",
      "backspace",
      "backspace",
      "backspace",
      "backspace",
    );
    m = press(m, SIZE, ..."Why?".split(""));
    expect(m.input?.text).toBe("NoWhy?");
    expect(text(m)).toContain("NoWhy?");
    m = press(m, SIZE, "tab");
    expect(m.input?.severity).toBe("minor");
    // keys with names are not text, and q does not quit while typing
    m = press(m, SIZE, "up", "q");
    expect(m.quit).toBe(false);
    expect(m.input?.text).toBe("NoWhy?q");
    expect(press(m, SIZE, "escape").input).toBeNull();
    const saved = press(m, SIZE, "enter");
    expect(saved.input).toBeNull();
    expect(saved.effects).toEqual([
      {
        type: "add_comment",
        runId: gate().id,
        node: "final-approval",
        attempt: 1,
        comment: {
          severity: "minor",
          location: "packages/cli/test/cli.test.ts",
          description: "NoWhy?q",
        },
      },
    ]);
    // nothing typed, nothing saved
    expect(press(press(withCard(), SIZE, "enter", "c"), SIZE, "enter").effects).toEqual([]);
  });

  test("text in any language goes in as it is", () => {
    const m = press(withCard(), SIZE, "enter", "c", ..."Тест 👍".split(""));
    expect(m.input?.text).toBe("Тест 👍");
  });

  test("the comments are listed with their text; d asks, y deletes the selected one, n keeps it", () => {
    const d = {
      ...detail(),
      comments: [
        { severity: "major", location: "a.ts:1", description: "first" },
        { severity: "info", location: "b.ts:2", description: "second one" },
      ],
    };
    let m = press(withCard(d), SIZE, ...toTab(TAB.comments));
    const out = text(m);
    expect(out).toContain("They go back to the agent when you reject.");
    expect(out).toContain("▸ major");
    expect(out).toContain("a.ts:1");
    expect(out).toContain("second one");
    m = press(m, SIZE, "down", "d");
    expect(m.confirm).toBe("d");
    expect(text(m)).toContain("Delete this comment?");
    expect(press(m, SIZE, "n").effects).toEqual([]);
    expect(press(m, SIZE, "y").effects).toEqual([
      { type: "delete_comment", runId: gate().id, node: "final-approval", attempt: 1, index: 1 },
    ]);
    expect(text(withCard())).not.toContain("Delete this");
    expect(press(withCard(), SIZE, ...toTab(TAB.comments), "d").confirm).toBeNull();
    expect(text(press(withCard(), SIZE, ...toTab(TAB.comments)))).toContain("No comments yet.");
  });

  test("the commands for deciding are still there from inside any tab", () => {
    for (const tab of [0, 1, 2, 3, 4]) {
      const m = press(withCard(), SIZE, ...toTab(tab));
      expect(update(m, "a", SIZE).confirm).toBe("a");
      expect(update(m, "r", SIZE).confirm).toBe("r");
    }
  });

  test("Log is what the agent said and the tools it called, and opens at its end", () => {
    let m = press(withCard(), SMALL, ...toTab(TAB.log));
    const out = text(m, SMALL);
    expect(out).toContain("agent Done: `kodel status` prints one short line per run.");
    expect(out).not.toContain("Make `kodel status` readable");
    expect(out).toContain("▲ PgUp for earlier");
    m = press(m, SMALL, ...n(6, "pageup"));
    expect(text(m, SMALL)).toContain("you   Make `kodel status` readable");
  });

  test("a tool call is a line and its result is the next one; a failed call says so", () => {
    const out = text(press(withCard(), { cols: 120, rows: 50 }, ...toTab(TAB.log)), {
      cols: 120,
      rows: 50,
    });
    expect(out).toMatch(/⚙ Read\s+AGENTS\.md/);
    expect(out).toMatch(/↳ ok 40ms · 2\.0 KB/);
    expect(out).toMatch(/⚙ Bash\s+bun run typecheck/);
    expect(out).toMatch(/↳ failed 40ms · 2\.0 KB\s+format\.ts\(9,3\): error TS23/);
    expect(out).toMatch(/⚙ kodel:pipeline_report_result\s+review: 3 rows/);
  });

  test("a step's Log is only what the agent did while that step went on", () => {
    const keys = [...toTab(TAB.steps), ...n(3, "down"), "enter", "right", "right"]; // impl #2, Log
    const out = text(press(withCard(), SIZE, ...keys));
    expect(out).toContain("Steps › impl #2");
    expect(out).toContain("splitting it: the table printer stays as it was.");
    expect(out).toMatch(/⚙ Bash\s+bun run typecheck/);
    expect(out).not.toContain("AGENTS.md");
    expect(out).not.toContain("Done: `kodel status`");
  });

  test("without the agent's log, Log says so and shows the pipeline's own records, and so does a step", () => {
    const d = { ...detail(), agentLog: undefined };
    const out = text(press(withCard(d), SIZE, ...toTab(TAB.log)));
    expect(out).toContain("The agent's own log can be read for Claude Code only.");
    expect(out).toContain("gate_waiting       final-approval");
    expect(text(withCard(d))).toContain("Log 14");
    const step = text(
      press(withCard(d), SIZE, ...toTab(TAB.steps), ...n(5, "down"), "enter", "right", "right"),
    );
    expect(step).toContain("09:30:31 command_finished   test exit 1");
  });

  test("→ and Tab go to the next tab, ← and Shift+Tab to the previous, and ← on the first tab is the list", () => {
    let m = press(withCard(), SIZE, "enter");
    expect(m.focus).toBe("card");
    expect(press(m, SIZE, "left").focus).toBe("list");
    m = press(m, SIZE, "right", "tab", "tab", "tab");
    expect(m.tab).toBe(4);
    expect(press(m, SIZE, "right").tab).toBe(4);
    expect(press(m, SIZE, "tab").tab).toBe(0);
    expect(press(m, SIZE, "shift-tab").tab).toBe(3);
    expect(press(m, SIZE, "left", "left", "left", "left").tab).toBe(0);
    expect(press(m, SIZE, "left", "left", "left", "left", "left").focus).toBe("list");
  });

  test("pressing a or r in a project says which command to run", () => {
    const project = { ...withCard(), source: "project" as const };
    const m = press(project, SIZE, "enter", "a");
    expect(m.confirm).toBeNull();
    expect(m.notice).toContain("In a terminal: kodel gate approve");
  });

  test("Esc steps back one level at a time: step, tab, list", () => {
    let m = press(withCard(), SIZE, ...toTab(TAB.steps), "enter");
    expect(m.open).toBe(true);
    m = press(m, SIZE, "escape");
    expect([m.open, m.focus]).toEqual([false, "card"]);
    m = press(m, SIZE, "escape");
    expect(m.focus).toBe("list");
  });

  test("z puts the list away and gives the card the whole width; z or Esc brings the list back", () => {
    let m = press(withCard(), SIZE, "z");
    expect([m.zoom, m.focus]).toEqual([true, "card"]);
    expect(text(m)).not.toContain("WAITING FOR YOU");
    expect(text(m)).toContain("z show list");
    expect(press(m, SIZE, "z").zoom).toBe(false);
    m = press(m, SIZE, "escape");
    expect([m.zoom, m.focus]).toEqual([false, "list"]);
  });

  test("moving to another run starts it on the Report", () => {
    let m = press(withCard(), SIZE, ...toTab(TAB.steps), "down", "enter");
    expect([m.tab, m.cursor, m.open]).toEqual([2, 1, true]);
    m = press(m, SIZE, "escape", "escape", "down");
    expect([m.tab, m.cursor, m.open, m.sub]).toEqual([0, 0, false, 0]);
  });

  test("until the details are read the card shows what it has, and says it is reading", () => {
    const m = { ...demo(), selected: gate().id };
    const out = text(m);
    expect(out).toContain("Reading the details…");
    expect(out).toContain("Step «review» waits for your decision");
    expect(out).not.toContain("╭");
  });

  test("with little room the band shrinks to three lines and there is no frame", () => {
    const out = text(press(withCard(), SMALL, "enter"), SMALL);
    expect(out).not.toContain("╭");
    expect(out).toContain("gate 2 of 2 · final-approval");
    expect(out).toContain("⏱ 1h32 work");
  });

  test("every line fits the width, in every tab, wide, zoomed and narrow", () => {
    const long = {
      ...detail(),
      changes: {
        kind: "files" as const,
        files: [
          ["packages/pipeline-core/src/some/very/deep/folder/with/a/long-file-name-indeed.ts", 9],
        ] as [string, number][],
        totalFiles: 1,
        totalLines: 9,
      },
      comments: [
        {
          severity: "major",
          location:
            "packages/pipeline-core/src/some/very/deep/folder/with/a/long-file-name-indeed.ts:12",
          description: "a long thought ".repeat(20),
        },
      ],
      report: {
        text: `${"long ".repeat(80)}\n\n- ${"item ".repeat(40)}\n\`\`\`\n${"x".repeat(300)}\n\`\`\``,
        ts: Date.now(),
        from: "log" as const,
      },
    };
    for (const size of [SIZE, { cols: 70, rows: 36 }, { cols: 41, rows: 20 }, SMALL]) {
      for (const zoom of [false, true]) {
        for (let tab = 0; tab < 5; tab++) {
          for (const open of [false, true]) {
            for (const sub of [0, 1, 2]) {
              const m = {
                ...withCard(long),
                focus: "card" as const,
                zoom: zoom && size.cols >= WIDE_COLS,
                tab,
                open,
                sub,
                input: sub === 1 ? { text: "hello", severity: "major", place: "x" } : null,
              };
              for (const line of render(m, size)) expect(visibleLength(line)).toBe(size.cols);
            }
          }
        }
      }
    }
  });
});

describe("tui card tabs with the mouse", () => {
  const SIZE = { cols: 120, rows: 44 };
  const gate = () => demoSessions(NOW).sessions.find((s) => s.need === "approve") as Session;
  const loaded = () => {
    const g = gate();
    return withDetail(
      { ...demo(), selected: g.id, mouse: true },
      detailKey(g),
      demoGateDetail(g.id, NOW) as GateDetail,
    );
  };
  const press = (x: number, y: number) => ({
    type: "mouse" as const,
    action: "press" as const,
    x,
    y,
  });
  const wheel = (action: "wheel_up" | "wheel_down", x: number) => ({
    type: "mouse" as const,
    action,
    x,
    y: 12,
  });
  /** Where a tab name is drawn: the row with all the tabs, and a column inside the name. */
  const stripAt = (m: ReturnType<typeof loaded>, name: string) => {
    const lines = plain(render(m, SIZE));
    const y = lines.findIndex((l) => l.includes("Report") && l.includes("Comments")) + 1;
    return { x: (lines[y - 1] ?? "").indexOf(name) + 2, y };
  };

  test("a click on a tab name opens that tab and puts the focus on the card", () => {
    const m = loaded();
    const { x, y } = stripAt(m, "Steps");
    expect(hitTest(m, SIZE, x, y)).toEqual({ kind: "tab", index: 2 });
    const next = mouseUpdate(m, SIZE, press(x, y));
    expect([next.tab, next.focus]).toEqual([2, "card"]);
    const code = stripAt(m, "Code");
    expect(mouseUpdate(m, SIZE, press(code.x, code.y)).tab).toBe(1);
    const log = stripAt(m, "Log");
    expect(mouseUpdate(m, SIZE, press(log.x, log.y)).tab).toBe(4);
  });

  test("a click inside the card puts the focus on it, a click on the list puts it back", () => {
    const m = loaded();
    const onCard = mouseUpdate(m, SIZE, press(100, 25));
    expect(onCard.focus).toBe("card");
    const row =
      plain(render(m, SIZE)).findIndex((l) => l.slice(0, 50).includes("usage and cost capture")) +
      1;
    expect(mouseUpdate(onCard, SIZE, press(3, row)).focus).toBe("list");
  });

  test("a click on another run moves there and starts it on the Report", () => {
    const m = { ...loaded(), tab: 2, cursor: 3, focus: "card" as const };
    const other = ordered(m.sessions).find((s) => s.id !== m.selected && s.status === "waiting");
    const row =
      plain(render(m, SIZE)).findIndex((l) =>
        l.slice(0, 50).includes(other?.agentSession?.name ?? other?.title ?? "?"),
      ) + 1;
    const next = mouseUpdate(m, SIZE, press(3, row));
    expect([next.selected, next.tab, next.cursor, next.focus]).toEqual([
      other?.id ?? "",
      0,
      0,
      "list",
    ]);
  });

  test("the wheel over a list tab moves its selection, over other tabs it scrolls", () => {
    const m = { ...loaded(), tab: 2, focus: "card" as const };
    expect(mouseUpdate(m, SIZE, wheel("wheel_down", 100)).cursor).toBe(1);
    expect(mouseUpdate(m, SIZE, wheel("wheel_down", 5)).selected).not.toBe(m.selected);
    const log = { ...m, tab: 4, cardScroll: 0 };
    const small = { cols: 120, rows: 20 };
    expect(mouseUpdate(log, small, wheel("wheel_down", 100)).cardScroll).toBeGreaterThan(0);
  });
});

describe("tui card of a run that is going on", () => {
  const SIZE = { cols: 120, rows: 44 };
  const going = () => demoSessions(NOW).sessions.find((s) => s.id === "r_1kd9q22vb") as Session;
  const detail = () => demoRunningDetail(going().id, NOW) as GateDetail;
  const withCard = (d: GateDetail = detail(), s: Session = going()) =>
    withDetail({ ...demo(), selected: s.id }, detailKey(s), d);
  const press = (m: ReturnType<typeof demo>, ...keys: string[]) =>
    keys.reduce((acc, k) => update(acc, k, SIZE), m);
  const text = (m: ReturnType<typeof demo>, size = SIZE) => plain(render(m, size)).join("\n");
  const strip = (m: ReturnType<typeof demo>) =>
    plain(render(m, SIZE)).find(
      (l) => l.includes("Steps") && l.includes("Code") && l.includes("Log"),
    ) ?? "";

  test("it has the band of a run at a gate, saying that the run is going on, where, and for how long", () => {
    const out = text(withCard());
    expect(out).toContain("╭");
    expect(out).toContain("fix-wait-timeout");
    expect(out).toContain("r_1kd9q22vb · dev");
    expect(out).toContain("running · checks · step 3 of 4 · for 9m");
    expect(out).toContain("⏱ 9m work · 0s waiting");
    expect(out).toContain("⟳ 1 retry");
    expect(out).toContain("✓ 2/2 checks");
    expect(out).toContain("± 3 files · 73 lines");
    expect(out).toContain("⛁ 61k tokens");
    expect(out).not.toContain("waiting for you");
  });

  test("a run that has gone quiet says so in the band", () => {
    const quiet = { ...going(), activity: "quiet" as const, quietMs: 12 * 60_000 };
    const band = (m: ReturnType<typeof demo>) =>
      plain(render(m, SIZE)).find((l) => l.includes("running · checks")) ?? "";
    const swapped = withCard();
    const gone = {
      ...swapped,
      sessions: swapped.sessions.map((x) => (x.id === quiet.id ? quiet : x)),
    };
    expect(band(gone)).toContain("quiet 12m");
    expect(band(withCard())).not.toContain("quiet");
  });

  test("it has Steps, Code and Log, and no Report to read and no Comments to make", () => {
    const line = strip(withCard());
    expect(line).toMatch(/Steps 4\]?\s+Code 3\s+Log 8/);
    expect(line).not.toContain("Report");
    expect(line).not.toContain("Comments");
    expect(line.indexOf("Steps")).toBeLessThan(line.indexOf("Code"));
  });

  test("it opens on Steps, where the calls of the run are in the order they happened, each try on a line", () => {
    const out = text(press(withCard(), "enter"));
    expect(out).toContain("4 entries into steps · Enter opens one");
    expect(out).toMatch(/✓\s+plan\s+agent\s+3m00/);
    expect(out).toMatch(/✗\s+implement\s+agent\s+2m00\s+The test check failed/);
    expect(out).toMatch(/✓ ↺ implement #2\s+agent\s+2m00/);
    expect(out).toMatch(/●\s+checks\s+command\s+2m00/);
  });

  test("the cursor starts on the step the run is at, not on the first one", () => {
    const m = press(withCard(), "enter");
    expect(m.cursor).toBe(3);
    expect(text(m)).toMatch(/▸ ●\s+checks\s+command/);
    // the other tabs start at the top, and so does a card of a gate
    expect(press(m, "right").cursor).toBe(0);
    const gate = demoSessions(NOW).sessions.find((s) => s.need === "approve") as Session;
    const atGate = withDetail(
      { ...demo(), selected: gate.id },
      detailKey(gate),
      demoGateDetail(gate.id, NOW) as GateDetail,
    );
    expect(press(atGate, "enter", "right", "right").cursor).toBe(0);
  });

  test("a try opens to its details: result, changes, and what the agent did while it went on", () => {
    let m = press(withCard(), "enter", "up", "up", "enter");
    expect(text(m)).toContain("Steps › implement");
    expect(text(m)).toContain("The test check failed: t40_wait_timeout_reports");
    m = press(m, "escape", "down", "enter");
    expect(text(m)).toContain("Steps › implement #2");
    expect(text(m)).toContain("The agent says (not verified):");
    m = press(m, "right", "right");
    const out = text(m);
    expect(out).toMatch(/⚙ Edit\s+packages\/cli\/src\/wait\.ts/);
    expect(out).toMatch(/⚙ Bash\s+bun test wait/);
    expect(out).not.toContain("Plan done");
    // the step that is still going has the same view, with what it has so far
    m = press(m, "escape", "down", "enter");
    expect(text(m)).toContain("Steps › checks");
    expect(text(m)).toContain("in progress");
  });

  test("Code and Log are the same as at a gate: the files, and the agent's own log", () => {
    const code = text(press(withCard(), "enter", "right"));
    expect(code).toContain("3 files · 73 lines · Enter opens a file");
    expect(code).toContain("▸ packages/cli/src/wait.ts");
    const log = text(press(withCard(), "enter", "right", "right"), { cols: 120, rows: 50 });
    expect(log).toMatch(/agent I will read the wait command first/);
    expect(log).toMatch(/↳ failed 35ms/);
  });

  test("the arrows and Tab go round the three tabs, and ← on the first one is the list", () => {
    let m = press(withCard(), "enter");
    expect(m.focus).toBe("card");
    expect(press(m, "left").focus).toBe("list");
    m = press(m, "right");
    expect(m.tab).toBe(1);
    m = press(m, "right", "right");
    expect(m.tab).toBe(4);
    expect(press(m, "tab").tab).toBe(2);
    expect(press(m, "shift-tab").tab).toBe(1);
    expect(press(press(m, "tab"), "shift-tab").tab).toBe(4);
  });

  test("there is no gate to comment at, so c does nothing, in the tabs and in a diff", () => {
    const base = press(withCard(), "enter", "right", "enter");
    const read = withDiff(base, diffKey(going().id, "packages/cli/src/wait.ts"), {
      kind: "text",
      text: "@@ -1,1 +1,2 @@\n a\n+b\n",
      truncated: false,
    });
    expect(press(read, "c").input).toBeNull();
    expect(press(withCard(), "enter", "c").input).toBeNull();
    expect(plain(render(press(withCard(), "enter"), SIZE)).at(-1)).not.toContain("comment");
  });

  test("when the card of a run that is going is read again, the open file is read again, and a failed read is forgotten", () => {
    const base = press(withCard(), "enter", "right", "enter");
    const path = fileAt(detail(), 0) as string;
    const key = diffKey(going().id, path);
    const text = { kind: "text" as const, text: "@@ -1 +1 @@\n-x\n+y\n", truncated: false };
    const again = withDetail(withDiff(base, key, text), detailKey(going()), detail());
    // what is shown stays until the new text arrives, and the new text is asked for
    expect(again.diffs[key]).toMatchObject({ kind: "text" });
    expect(again.effects).toContainEqual({ type: "load_diff", runId: going().id, path });
    const failed = withDiff(base, key, { kind: "error", message: "git failed" });
    expect(withDetail(failed, detailKey(going()), detail()).diffs[key]).toBeUndefined();
  });

  test("a file that is not open is not read again, and what was read of another run is kept", () => {
    const closed = press(withCard(), "enter", "right");
    expect(withDetail(closed, detailKey(going()), detail()).effects).toEqual([]);
    const other = diffKey("r_other", "a.ts");
    const kept = withDiff(closed, other, { kind: "error", message: "x" });
    expect(withDetail(kept, detailKey(going()), detail()).diffs[other]).toEqual({
      kind: "error",
      message: "x",
    });
  });

  test("the diff that is drawn is the diff that the keys act on, when the list of files has got shorter", () => {
    const d = detail();
    const last = fileAt(d, itemCount(d, CODE) - 1) as string;
    const lines = Array.from({ length: 30 }, (_, i) => `+line ${i}`).join("\n");
    const read = withDiff(
      { ...press(withCard(), "enter", "right", "enter"), cursor: itemCount(d, CODE) + 3, line: 0 },
      diffKey(going().id, last),
      { kind: "text", text: `@@ -0,0 +1,30 @@\n${lines}\n`, truncated: false },
    );
    // the cursor is past the last file; the diff of the last file is on screen, so the keys move in it
    expect(press(read, "down").line).toBeGreaterThan(read.line);
  });

  test("a and r mean nothing for a run that waits for no one", () => {
    const m = press(withCard(), "enter");
    expect(update(m, "a", SIZE).confirm).toBeNull();
    expect(update(m, "r", SIZE).confirm).toBeNull();
  });

  test("a click on a tab name opens that tab, by the tabs this card has", () => {
    const m = { ...withCard(), mouse: true };
    const lines = plain(render(m, SIZE));
    const y =
      lines.findIndex((l) => l.includes("Steps") && l.includes("Code") && l.includes("Log")) + 1;
    const x = (lines[y - 1] ?? "").indexOf("Log") + 2;
    expect(hitTest(m, SIZE, x, y)).toEqual({ kind: "tab", index: 4 });
    const next = mouseUpdate(m, SIZE, { type: "mouse", action: "press", x, y });
    expect([next.tab, next.focus]).toEqual([4, "card"]);
  });

  test("another run's tab is not left over: a run that has no such tab starts on its first", () => {
    const gate = demoSessions(NOW).sessions.find((s) => s.need === "approve") as Session;
    const both = withDetail(
      withDetail(
        { ...demo(), selected: going().id, tab: 0 },
        detailKey(gate),
        demoGateDetail(gate.id, NOW) as GateDetail,
      ),
      detailKey(going()),
      detail(),
    );
    // Report is tab 0 at a gate, and does not exist here
    expect(strip(press(both, "enter"))).toContain("Steps");
    expect(press(both, "enter").tab).toBe(2);
    expect(press(both, "enter", "left").focus).toBe("list");
  });

  test("until the card is read it shows what there is, and says it is reading", () => {
    const out = text({ ...demo(), selected: going().id });
    expect(out).toContain("Reading the details…");
    expect(out).not.toContain("╭");
  });

  test("every line fits the width, in every tab, wide, zoomed and narrow", () => {
    for (const size of [
      SIZE,
      { cols: 70, rows: 36 },
      { cols: 41, rows: 20 },
      { cols: 120, rows: 16 },
    ]) {
      for (const zoom of [false, true]) {
        for (const tab of [1, 2, 4]) {
          for (const open of [false, true]) {
            for (const sub of [0, 1, 2]) {
              const m = {
                ...withCard(),
                focus: "card" as const,
                zoom: zoom && size.cols >= WIDE_COLS,
                tab,
                open,
                sub,
              };
              for (const line of render(m, size)) expect(visibleLength(line)).toBe(size.cols);
            }
          }
        }
      }
    }
  });
});

describe("tui durations", () => {
  test("a time is told in the unit that fits, and a rounded second never makes a minute of sixty", () => {
    expect(duration(250)).toBe("250ms");
    expect(duration(1631)).toBe("1.6s");
    expect(duration(59_000)).toBe("59.0s");
    expect(duration(85_684)).toBe("1m26");
    expect(duration(29 * 60_000 + 59_700)).toBe("30m00");
    expect(duration(59_960)).toBe("1m00");
    expect(duration(59 * 60_000 + 59_600)).toBe("1h00");
    expect(duration(3_600_000)).toBe("1h00");
    expect(duration(1344 * 60_000)).toBe("22h");
    expect(duration(3 * 24 * 3_600_000)).toBe("3d");
  });
});

describe("tui readable reasons", () => {
  const SIZE = { cols: 120, rows: 60 };
  const gate = () => demoSessions(NOW).sessions.find((s) => s.need === "approve") as Session;
  const FINDINGS = [
    '{"severity":"critical","location":"plan Risks 8, Step 1; canonical.ts:89, pipeline-host.ts:707-716, and a very long place that goes on and on until it has to be wrapped onto the next line of the screen","description":"[invariants] The plan says an old run is parsed by its own reader. It is not."}',
    '{"severity":"major","location":"plan Step 5","description":"[gaps] The guard must accept gate decisions while paused."}',
  ].join("; ");
  const withVisits = (extra: GateDetail["visits"]) => {
    const d = demoGateDetail(gate().id, NOW) as GateDetail;
    const m = withDetail({ ...demo(), selected: gate().id }, detailKey(gate()), {
      ...d,
      visits: [...extra, ...d.visits],
    });
    return m;
  };
  const failed: GateDetail["visits"][number] = {
    slug: "plan-critique",
    kind: "agent",
    human: false,
    state: "failed",
    rework: false,
    attempt: {
      n: 1,
      outcome: "blocking_findings",
      ok: false,
      ms: 669_000,
      reason: `2 blocking findings: ${FINDINGS}`,
      checks: [{ node: "plan-critique", label: "plan-critique result", passed: false, ms: 58 }],
      log: [],
    },
  };
  const rejected: GateDetail["visits"][number] = {
    slug: "plan-approval",
    kind: "human",
    human: true,
    state: "failed",
    rework: false,
    attempt: {
      n: 1,
      outcome: "rejected",
      ok: false,
      ms: 22 * 3_600_000,
      checks: [],
      decision: {
        decision: "rejected",
        reason:
          'Fix the plan first.\n\nComments (CSV):\nseverity,location,description\nmajor,plan Step 5,"Why not ""movable""?"',
      },
      review: {
        completeness: "complete",
        findings: [
          { severity: "major", location: "plan Step 5", description: 'Why not "movable"?' },
        ],
      },
      log: [],
    },
  };
  const press = (m: ReturnType<typeof demo>, ...keys: string[]) =>
    keys.reduce((a, k) => update(a, k, SIZE), m);
  const text = (m: ReturnType<typeof demo>) => plain(render(m, SIZE)).join("\n");

  test("in the list a failure is told in a few words, never as the JSON the engine sends", () => {
    const out = text(press(withVisits([failed, rejected]), "enter", "right", "right"));
    expect(out).toMatch(/plan-critique\s+agent\s+11m09\s+2 blocking findings/);
    expect(out).not.toContain('{"severity"');
    expect(out).not.toContain("blocking_findings");
  });

  test("a rejection is told once, and what was recorded at a human step is comments", () => {
    const out = text(press(withVisits([failed, rejected]), "enter", "right", "right"));
    expect(out).toMatch(/plan-approval\s+human\s+22h\s+rejected · 1 comment/);
    expect(out).not.toContain("rejected · rejected");
  });

  test("inside the try, the findings are laid out: how serious, where, and what", () => {
    const out = text(
      press(withVisits([failed]), "enter", "right", "right", "pageup", "pageup", "enter"),
    );
    expect(out).toContain("2 blocking findings");
    expect(out).toMatch(/critical\s+plan Risks 8, Step 1;/);
    expect(out).toMatch(/major\s+plan Step 5/);
    expect(out).toContain("[invariants] The plan says an old run");
    expect(out).toContain("It is not.");
    expect(out).not.toContain('{"severity"');
    expect(out).not.toContain("…plan");
  });

  test("a severity as long as the column still has a space before the place", () => {
    const out = text(
      press(withVisits([failed]), "enter", "right", "right", "pageup", "pageup", "enter"),
    );
    expect(out).not.toMatch(/criticalplan/);
    expect(out).toMatch(/critical plan Risks/);
  });

  test("a long place wraps under its severity, and is never cut", () => {
    const m = press(withVisits([failed]), "enter", "right", "right", "enter", "z");
    const lines = plain(render(m, SIZE));
    const at = lines.findIndex((l) => l.includes("critical"));
    const place = lines.slice(at, at + 4).join(" ");
    expect(place).toContain("plan Risks 8, Step 1; canonical.ts:89");
    expect(place).toContain("screen");
    expect(lines[at]).not.toContain("…");
  });

  test("a rejection shows what the person wrote and their comments, once, when the report and the copy agree", () => {
    const out = text(
      press(withVisits([rejected]), "enter", "right", "right", "pageup", "pageup", "enter"),
    );
    expect(out).toContain("You: rejected");
    expect(out).toContain("Fix the plan first.");
    expect(out).toContain("Comments you made: 1 major");
    expect(out).toContain('Why not "movable"?'.slice(0, 11));
    expect(out).not.toContain("Comments (CSV)");
    expect(out).not.toContain("Comments recorded at this step");
    expect(out).not.toContain("Findings (the agent's");
    expect(out.match(/Why not/g)).toHaveLength(1);
  });

  test("when the report no longer says what the rejection carried, both are shown and told apart", () => {
    const changed = {
      ...rejected,
      attempt: {
        ...rejected.attempt,
        review: {
          completeness: "complete",
          findings: [
            { severity: "info", location: "plan Step 9", description: "A later thought." },
          ],
        },
      },
    };
    const out = text(
      press(withVisits([changed]), "enter", "right", "right", "pageup", "pageup", "enter"),
    );
    expect(out).toContain("Comments sent back with the rejection: 1 major");
    expect(out).toContain("Comments recorded at this step (complete): 1 info");
    expect(out).toContain("A later thought.");
  });

  test("a human step that is still waiting has only what is recorded so far", () => {
    const waiting = {
      ...rejected,
      state: "waiting" as const,
      attempt: { ...rejected.attempt, ok: undefined, outcome: undefined, decision: undefined },
    };
    const out = text(
      press(withVisits([waiting]), "enter", "right", "right", "pageup", "pageup", "enter"),
    );
    expect(out).toContain("Comments recorded at this step (complete): 1 major");
    expect(out).not.toContain("Comments you made");
    expect(out).not.toContain("You:");
  });

  test("a reason that is plain text is shown as written, but a very long one is cut", () => {
    const long = {
      ...failed,
      attempt: {
        ...failed.attempt,
        reason: Array.from({ length: 40 }, (_, i) => `line ${i} of the test output`).join("\n"),
      },
    };
    const out = text(
      press(withVisits([long]), "enter", "right", "right", "pageup", "pageup", "enter"),
    );
    expect(out).toContain("line 0 of the test output");
    expect(out).toContain("line 11 of the test output");
    expect(out).not.toContain("line 12 of the test output");
    expect(out).toContain("… 28 more lines");
  });
});
