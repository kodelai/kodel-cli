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
    const detail = demoGateDetail(gate?.id ?? "") as GateDetail;
    const base = { ...withDetail({ ...on(), selected: gate?.id ?? "" }, key, detail), tab: 3 };
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
  const SIZE = { cols: 120, rows: 36 };
  const SMALL = { cols: 120, rows: 16 };
  const gate = () => demoSessions(NOW).sessions.find((s) => s.need === "approve") as Session;
  const detail = () => demoGateDetail(gate().id) as GateDetail;
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
  const STEP = { plan: 0, impl: 2, test: 4, review: 6, final: 7 };

  test("Enter puts the focus on the card and Esc gives it back; the divider shows where it is", () => {
    let m = withCard();
    expect(m.focus).toBe("list");
    expect(text(m)).toContain(" │ ");
    m = press(m, SIZE, "enter");
    expect(m.focus).toBe("card");
    expect(text(m)).toContain(" ┃ ");
    expect(text(m)).toMatch(/›.*capture-usage-cost/);
    m = press(m, SIZE, "escape");
    expect(m.focus).toBe("list");
  });

  test("Summary is short: the question, the engine's verdict and the counts, nothing to wade through", () => {
    const out = text(press(withCard(), SIZE, "enter"));
    expect(out).toContain("gate 2 of 2 · final-approval");
    expect(out).toContain("You are asked");
    expect(out).toContain("Look at the diff and try the change.");
    expect(out).toContain("Engine checks: all 6 passed");
    expect(out).toContain("Changes 5 files · 379 lines");
    expect(out).toContain("impl ran 2 times");
    for (const gone of ["cli.test.ts", "Findings", "minor", "try 1", "JOURNAL"]) {
      expect(out).not.toContain(gone);
    }
  });

  test("the tabs show what is behind them: counts on the tabs, a mark where something is wrong", () => {
    const out = text(withCard());
    expect(out).toContain("Summary");
    expect(out).toContain("Changes 5");
    expect(out).toContain("Steps 8");
    expect(out).toContain("Journal 14");
    const late = text(withCard({ ...detail(), changedAfterChecks: ["x.ts"] }));
    expect(late).toContain("Changes 5 ⚠");
    const broken = detail();
    const steps = broken.steps.map((s) =>
      s.slug === "test" ? { ...s, state: "failed" as const } : s,
    );
    expect(text(withCard({ ...broken, steps }))).toContain("Steps 8 ✗");
  });

  test("→ and Tab go to the next tab, ← and Shift+Tab to the previous, and ← stops at the first", () => {
    let m = press(withCard(), SIZE, "enter");
    expect(m.tab).toBe(0);
    m = press(m, SIZE, "left");
    expect(m.tab).toBe(0);
    expect(m.focus).toBe("card");
    m = press(m, SIZE, "right");
    expect(m.tab).toBe(1);
    m = press(m, SIZE, "tab", "tab");
    expect(m.tab).toBe(3);
    expect(press(m, SIZE, "right").tab).toBe(3);
    expect(press(m, SIZE, "tab").tab).toBe(0);
    expect(press(m, SIZE, "shift-tab").tab).toBe(2);
  });

  test("Changes lists the files, ↑↓ pick one, Enter opens it, n and p walk the files, Esc comes back", () => {
    let m = press(withCard(), SIZE, "enter", "right");
    const list = text(m);
    expect(list).toContain("5 files · 379 lines");
    expect(list).toContain("▸ packages/cli/test/cli.test.ts");
    m = press(m, SIZE, "down", "down");
    expect(text(m)).toContain("▸ packages/cli/src/format.ts");
    m = press(m, SIZE, "enter");
    expect(m.open).toBe(true);
    expect(text(m)).toContain("Changes › packages/cli/src/format.ts");
    m = press(m, SIZE, "n");
    expect(text(m)).toContain("Changes › docs/plans/make-status-readable.md");
    m = press(m, SIZE, "p", "p");
    expect(text(m)).toContain("Changes › packages/cli/src/cli.ts");
    m = press(m, SIZE, "escape");
    expect(m.open).toBe(false);
    expect(m.focus).toBe("card");
    expect(m.cursor).toBe(1);
    expect(press(m, SIZE, "escape").focus).toBe("list");
  });

  test("Steps has a line per step with its verdict and what was notable", () => {
    const out = text(press(withCard(), SIZE, "enter", "right", "right"));
    expect(out).toContain("8 steps · Enter opens one");
    expect(out).toMatch(/✓ plan-approval\s+human\s+9m00\s+approved/);
    expect(out).toMatch(/✓ impl\s+agent\s+3m00\s+2 tries, 1 failed/);
    expect(out).toMatch(/✓ test\s+command\s+1m26\s+2 tries, 1 failed/);
    expect(out).toMatch(/✓ review\s+agent\s+20\.0s\s+3 findings/);
    expect(out).toMatch(/◐ final-approval\s+human\s+waiting for you/);
  });

  test("a step opens to its tries, the newest first, with why the failed one failed", () => {
    const m = press(
      withCard(),
      SIZE,
      "enter",
      "tab",
      "tab",
      ...Array<string>(STEP.test).fill("down"),
      "enter",
    );
    const out = text(m);
    expect(out).toContain("Steps › test");
    expect(out).toContain("command · 2 tries");
    expect(out.indexOf("try 2")).toBeGreaterThan(-1);
    expect(out.indexOf("try 2")).toBeLessThan(out.indexOf("try 1"));
    expect(out).toContain("exit 1");
    expect(out).toContain("1 test failed: t40_wait_timeout_reports");
  });

  test("findings belong to the review step, in full, marked as the agent's", () => {
    const m = press(
      withCard(),
      SIZE,
      "enter",
      "tab",
      "tab",
      ...Array<string>(STEP.review).fill("down"),
      "enter",
    );
    const out = text(m, { cols: 120, rows: 50 });
    expect(out).toContain("Steps › review");
    expect(out).toContain("Findings (the agent's, complete): 2 minor · 1 info");
    expect(out).toContain("packages/cli/test/cli.test.ts:296");
    expect(out).toContain("coverage gap only");
  });

  test("what the agent says about a step is marked as not verified, and a person's decision shows its reason", () => {
    const d = detail();
    const steps = d.steps.map((s) => {
      if (s.slug === "impl") {
        return {
          ...s,
          attempts: s.attempts.map((a) => ({ ...a, summary: "Rewrote the table printer." })),
        };
      }
      if (s.slug === "plan-approval") {
        return {
          ...s,
          attempts: [
            {
              ...s.attempts[0],
              n: 1,
              checks: [],
              decision: { decision: "rejected", reason: "no tests in the plan" },
            },
          ],
        };
      }
      return s;
    }) as GateDetail["steps"];
    const base = withCard({ ...d, steps });
    const impl = text(press(base, SIZE, "enter", "tab", "tab", "down", "down", "enter"));
    expect(impl).toContain("Agent says (not verified):");
    expect(impl).toContain("Rewrote the table printer.");
    const human = text(press(base, SIZE, "enter", "tab", "tab", "down", "enter"));
    expect(human).toContain("You: rejected — “no tests in the plan”");
  });

  test("warnings are on Summary: files that changed after the checks, a check that failed, changes that cannot be told", () => {
    const d = detail();
    const after = text(
      press(withCard({ ...d, changedAfterChecks: ["a.ts", "b.ts"] }), SIZE, "enter"),
    );
    expect(after).toContain("⚠ 2 files changed after the checks passed");
    const failed = text(
      press(
        withCard({ ...d, checks: [{ node: "test", label: "test", passed: false }] }),
        SIZE,
        "enter",
      ),
    );
    expect(failed).toContain("✗ 1 of 1 checks failed: test");
    const unknown = withCard({ ...d, changes: { kind: "unavailable", reason: "git failed" } });
    expect(text(press(unknown, SIZE, "enter"))).toContain("⚠ Cannot tell what changed: git failed");
    expect(text(press(unknown, SIZE, "enter", "right"))).toContain(
      "Cannot tell what changed: git failed",
    );
    expect(text(press(unknown, SIZE, "enter", "right"))).not.toContain("No files changed");
  });

  test("Journal opens at its end, where the newest records are, and scrolls up from there", () => {
    let m = press(withCard(), SMALL, "enter", "tab", "tab", "tab");
    const out = text(m, SMALL);
    expect(out).toContain("gate_waiting       final-approval");
    expect(out).not.toContain("run_started");
    expect(out).toContain("▲ PgUp for earlier");
    m = press(m, SMALL, "pageup", "pageup");
    expect(text(m, SMALL)).toContain("run_started");
  });

  test("z puts the list away and gives the card the whole width; z or Esc brings the list back", () => {
    let m = press(withCard(), SIZE, "z");
    expect(m.zoom).toBe(true);
    expect(m.focus).toBe("card");
    const out = text(m);
    expect(out).not.toContain("WAITING FOR YOU");
    expect(out).toContain("Summary");
    expect(out).toContain("z show list");
    expect(press(m, SIZE, "z").zoom).toBe(false);
    m = press(m, SIZE, "escape");
    expect(m.zoom).toBe(false);
    expect(m.focus).toBe("list");
    expect(text(m)).toContain("WAITING FOR YOU");
  });

  test("moving to another run starts it on Summary", () => {
    let m = press(withCard(), SIZE, "enter", "right", "down");
    expect(m.tab).toBe(1);
    expect(m.cursor).toBe(1);
    m = press(m, SIZE, "escape", "down");
    expect(m.tab).toBe(0);
    expect(m.cursor).toBe(0);
    expect(m.open).toBe(false);
  });

  test("the keys that decide still work from inside the card", () => {
    const m = press(withCard(), SIZE, "enter", "right");
    expect(update(m, "a", SIZE).confirm).toBe("a");
    expect(update(m, "q", SIZE).quit).toBe(true);
  });

  test("until the details are read the card shows what it has, and says it is reading", () => {
    const m = { ...demo(), selected: gate().id };
    const out = text(m);
    expect(out).toContain("Reading the details…");
    expect(out).toContain("Step «review» waits for your decision");
    expect(out).not.toContain("Summary  Changes");
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
    };
    for (const size of [SIZE, { cols: 70, rows: 36 }, { cols: 41, rows: 20 }]) {
      for (const zoom of [false, true]) {
        for (let tab = 0; tab < 4; tab++) {
          for (const open of [false, true]) {
            const m = {
              ...withCard(long),
              focus: "card" as const,
              zoom: zoom && size.cols >= WIDE_COLS,
              tab,
              open,
            };
            for (const line of render(m, size)) expect(visibleLength(line)).toBe(size.cols);
          }
        }
      }
    }
  });
});

describe("tui card tabs with the mouse", () => {
  const SIZE = { cols: 120, rows: 36 };
  const gate = () => demoSessions(NOW).sessions.find((s) => s.need === "approve") as Session;
  const loaded = () => {
    const g = gate();
    const m = withDetail(
      { ...demo(), selected: g.id, mouse: true },
      detailKey(g),
      demoGateDetail(g.id) as GateDetail,
    );
    return m;
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
    y: 8,
  });
  const stripAt = (m: ReturnType<typeof loaded>, name: string) => {
    const line = plain(render(m, SIZE))[3] ?? "";
    return { x: line.indexOf(name) + 2, y: 4 };
  };

  test("a click on a tab name opens that tab and puts the focus on the card", () => {
    const m = loaded();
    const { x, y } = stripAt(m, "Steps");
    expect(hitTest(m, SIZE, x, y)).toEqual({ kind: "tab", index: 2 });
    const next = mouseUpdate(m, SIZE, press(x, y));
    expect(next.tab).toBe(2);
    expect(next.focus).toBe("card");
    const changes = stripAt(m, "Changes");
    expect(mouseUpdate(m, SIZE, press(changes.x, changes.y)).tab).toBe(1);
  });

  test("a click inside the card puts the focus on it, a click on the list puts it back", () => {
    const m = loaded();
    const onCard = mouseUpdate(m, SIZE, press(100, 12));
    expect(onCard.focus).toBe("card");
    const row =
      plain(render(m, SIZE)).findIndex((l) => l.slice(0, 50).includes("capture-usage-cost")) + 1;
    const back = mouseUpdate(onCard, SIZE, press(3, row));
    expect(back.focus).toBe("list");
  });

  test("a click on another run moves there and starts it on Summary", () => {
    let m = loaded();
    m = { ...m, tab: 2, cursor: 3, focus: "card" };
    const other = ordered(m.sessions).find((s) => s.id !== m.selected && s.status === "waiting");
    const row = plain(render(m, SIZE)).findIndex((l) => l.includes(other?.title ?? "?")) + 1;
    const next = mouseUpdate(m, SIZE, press(3, row));
    expect(next.selected).toBe(other?.id ?? "");
    expect(next.tab).toBe(0);
    expect(next.cursor).toBe(0);
    expect(next.focus).toBe("list");
  });

  test("the wheel over a list tab moves its selection, over other tabs it scrolls", () => {
    const m = { ...loaded(), tab: 2, focus: "card" as const };
    expect(mouseUpdate(m, SIZE, wheel("wheel_down", 100)).cursor).toBe(1);
    expect(mouseUpdate(m, SIZE, wheel("wheel_down", 5)).selected).not.toBe(m.selected);
    const journal = { ...m, tab: 3 };
    const small = { cols: 120, rows: 14 };
    expect(
      mouseUpdate({ ...journal, cardScroll: 0 }, small, wheel("wheel_down", 100)).cardScroll,
    ).toBeGreaterThan(0);
  });
});
