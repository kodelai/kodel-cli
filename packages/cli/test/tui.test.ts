import { describe, expect, test } from "bun:test";
import { stripAnsi, visibleLength } from "../src/tui/ansi";
import { demoSessions } from "../src/tui/demo";
import { formatAge } from "../src/tui/session";
import {
  initialModel,
  isAnimated,
  ordered,
  render,
  tick,
  update,
  WIDE_COLS,
  withData,
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
