import { describe, expect, test } from "bun:test";
import { stripAnsi, visibleLength } from "../src/tui/ansi";
import { demoGateDetail, demoSessions } from "../src/tui/demo";
import type { GateDetail, Session } from "../src/tui/session";
import { formatAge } from "../src/tui/session";
import {
  detailKey,
  hitTest,
  initialModel,
  isAnimated,
  mouseUpdate,
  ordered,
  render,
  tick,
  update,
  WIDE_COLS,
  withData,
  withDetail,
} from "../src/tui/view";

const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
const plain = (lines: string[]) => lines.map(stripAnsi);
const screen = (m: ReturnType<typeof initialModel>, cols = 120, rows = 30) =>
  plain(render(m, { cols, rows })).join("\n");
const demo = () => initialModel(demoSessions(NOW), "demo", NOW);

describe("tui sessions list", () => {
  test("waiting come first with the longest wait on top, then running, then failed before the rest", () => {
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
    expect(since).toEqual([...since].sort((a, b) => a - b));
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
    expect(text).toMatch(/capture-usage-cost.*\b21m\b/);
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
    expect(screen(m)).toContain("2 Pipeline 1");
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

  test("a click on a heading, a gap, the card or below the list selects nothing", () => {
    const m = on();
    const heading = rowOf(m, WIDE, "WAITING FOR YOU");
    expect(hitTest(m, WIDE, 3, heading)).toBeUndefined();
    expect(hitTest(m, WIDE, 3, heading + 5)).toBeUndefined();
    const y = rowOf(m, WIDE, "fix-wait-timeout");
    expect(hitTest(m, WIDE, 100, y)).toBeUndefined();
    expect(hitTest(m, WIDE, 3, 2)).toBeUndefined();
    expect(hitTest(m, WIDE, 3, WIDE.rows)).toBeUndefined();
  });

  test("on a narrow screen the second click on a row opens its card, and the card is not clickable", () => {
    let m = on();
    const y = rowOf(m, NARROW, "fix-wait-timeout");
    m = mouseUpdate(m, NARROW, press(5, y));
    expect(m.selected).toBe("r_1kd9q22vb");
    expect(m.focus).toBe("list");
    m = mouseUpdate(m, NARROW, press(5, y));
    expect(m.focus).toBe("card");
    expect(mouseUpdate(m, NARROW, press(5, y))).toBe(m);
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
    const base = withDetail({ ...on(), selected: gate?.id ?? "" }, key, detail);
    const small = { cols: 70, rows: 16 };
    const card = { ...base, focus: "card" as const };
    const scrolled = mouseUpdate(card, small, wheel("wheel_down"));
    expect(scrolled.cardScroll).toBeGreaterThan(0);
    expect(scrolled.selected).toBe(card.selected);
    const wide = { cols: 120, rows: 16 };
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
  const SIZE = { cols: 120, rows: 36 };
  const gate = () => demoSessions(NOW).sessions.find((s) => s.need === "approve") as Session;
  const withCard = () => {
    const g = gate();
    const m = { ...demo(), selected: g.id };
    return withDetail(m, detailKey(g), demoGateDetail(g.id, NOW) as GateDetail);
  };
  const text = (m: ReturnType<typeof demo>, size = SIZE) => plain(render(m, size)).join("\n");

  test("it says which gate this is, and the way the run took to get there", () => {
    const out = text(withCard());
    expect(out).toContain("gate 2 of 2 · final-approval");
    expect(out).toMatch(/plan ✓ → plan-approval ✓ → impl ×2 ✓/);
    expect(out).toContain("◐ final-approval");
  });

  test("it puts the question first, then what the engine checked, then what changed", () => {
    const out = text(withCard());
    const at = (needle: string) => out.indexOf(needle);
    expect(at("You are asked")).toBeGreaterThan(-1);
    expect(at("CHECKED BY THE ENGINE")).toBeGreaterThan(at("You are asked"));
    expect(at("CHANGES")).toBeGreaterThan(at("CHECKED BY THE ENGINE"));
    expect(at("FINDINGS")).toBeGreaterThan(at("CHANGES"));
    expect(out).toContain("Look at the diff and try the change.");
  });

  test("checks the engine ran are told apart from what the agent says", () => {
    const out = text(withCard());
    expect(out).toContain("CHECKED BY THE ENGINE · 6 passed");
    expect(out).toContain("test 1m26");
    expect(out).toContain("REVIEW FINDINGS · the agent's");
    expect(out).not.toContain("agent says");
  });

  test("findings come most severe first, a few of them, and the rest are counted", () => {
    const g = gate();
    const detail = demoGateDetail(g.id, NOW) as GateDetail;
    const many: GateDetail = {
      ...detail,
      review: {
        node: "review",
        completeness: "complete",
        findings: [
          { severity: "info", location: "a.ts:1", description: "i1" },
          { severity: "info", location: "b.ts:2", description: "i2" },
          { severity: "major", location: "c.ts:3", description: "m1" },
          { severity: "minor", location: "d.ts:4", description: "n1" },
          { severity: "info", location: "e.ts:5", description: "i3" },
        ],
      },
    };
    const out = text(withDetail({ ...demo(), selected: g.id }, detailKey(g), many), {
      cols: 120,
      rows: 60,
    });
    expect(out.indexOf("c.ts:3")).toBeGreaterThan(-1);
    expect(out.indexOf("c.ts:3")).toBeLessThan(out.indexOf("d.ts:4"));
    expect(out).toContain("… 2 more");
    expect(out).toContain("1 major");
  });

  test("changes after the checks, and changes that cannot be told, are warnings, not silence", () => {
    const g = gate();
    const detail = demoGateDetail(g.id, NOW) as GateDetail;
    const m = { ...demo(), selected: g.id };
    const after = text(
      withDetail(m, detailKey(g), { ...detail, changedAfterChecks: ["src/a.ts", "src/b.ts"] }),
    );
    expect(after).toContain("⚠ 2 files changed after the checks passed");
    const unavailable = text(
      withDetail(m, detailKey(g), {
        ...detail,
        changes: { kind: "unavailable", reason: "git failed" },
      }),
    );
    expect(unavailable).toContain("Cannot tell what changed: git failed");
    expect(unavailable).not.toContain("No files changed");
    const failed = text(
      withDetail(m, detailKey(g), {
        ...detail,
        checks: [{ node: "test", label: "test", passed: false }],
      }),
    );
    expect(failed).toContain("✗ test");
    expect(failed).toContain("1 failed");
  });

  test("until the details are read the card shows what it has, and says it is reading", () => {
    const m = { ...demo(), selected: gate().id };
    const out = text(m);
    expect(out).toContain("Reading the details…");
    expect(out).toContain("Step «review» waits for your decision");
  });

  test("a long card scrolls by page and by the keys, and stops at both ends", () => {
    const small = { cols: 120, rows: 16 };
    let m = withCard();
    expect(text(m, small)).toContain("▼ PgDn for more");
    m = update(m, "pagedown", small);
    expect(m.cardScroll).toBe(10);
    expect(text(m, small)).toContain("▲ PgUp for earlier");
    for (let i = 0; i < 20; i++) m = update(m, " ", small);
    const end = m.cardScroll;
    expect(update(m, "pagedown", small).cardScroll).toBe(end);
    expect(text(m, small)).not.toContain("▼ PgDn for more");
    for (let i = 0; i < 20; i++) m = update(m, "b", small);
    expect(m.cardScroll).toBe(0);
  });

  test("moving to another run starts its card at the top", () => {
    const small = { cols: 120, rows: 16 };
    let m = update(withCard(), "pagedown", small);
    expect(m.cardScroll).toBeGreaterThan(0);
    m = update(m, "down", small);
    expect(m.cardScroll).toBe(0);
  });

  test("every line of the card fits the width, even a long path and a long file name", () => {
    const g = gate();
    const detail = demoGateDetail(g.id, NOW) as GateDetail;
    const long: GateDetail = {
      ...detail,
      changes: {
        kind: "files",
        files: [
          ["packages/pipeline-core/src/some/very/deep/folder/with/a/long-file-name-indeed.ts", 9],
        ],
        totalFiles: 1,
        totalLines: 9,
      },
    };
    for (const size of [
      { cols: 120, rows: 36 },
      { cols: 70, rows: 36 },
    ]) {
      const m = withDetail(
        { ...demo(), selected: g.id, focus: "card" as const },
        detailKey(g),
        long,
      );
      for (const line of render(m, size)) expect(visibleLength(line)).toBe(size.cols);
    }
  });
});
