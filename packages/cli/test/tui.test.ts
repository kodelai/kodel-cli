import { describe, expect, test } from "bun:test";
import { stripAnsi, visibleLength } from "../src/tui/ansi";
import { DEMO_SESSIONS } from "../src/tui/demo";
import { keyName } from "../src/tui/run";
import { initialModel, ordered, render, update, WIDE_COLS } from "../src/tui/view";

const plain = (lines: string[]) => lines.map(stripAnsi);

describe("tui layout prototype", () => {
  test("sessions waiting for a person come first, in every group order", () => {
    const first = ordered(DEMO_SESSIONS).map((s) => s.status);
    const lastWaiting = first.lastIndexOf("waiting");
    expect(first.indexOf("running")).toBeGreaterThan(lastWaiting);
    expect(first.slice(0, lastWaiting + 1).every((s) => s === "waiting")).toBe(true);
  });

  test("every line fits the width at wide, narrow and tiny sizes", () => {
    for (const size of [
      { cols: 120, rows: 32 },
      { cols: WIDE_COLS, rows: 24 },
      { cols: 70, rows: 20 },
      { cols: 40, rows: 12 },
    ]) {
      const lines = render(initialModel(DEMO_SESSIONS), size);
      expect(lines.length).toBeLessThanOrEqual(size.rows);
      for (const line of lines) expect(visibleLength(line)).toBe(size.cols);
    }
  });

  test("wide terminal shows list and card together, narrow shows one at a time", () => {
    const model = initialModel(DEMO_SESSIONS);
    const wide = plain(render(model, { cols: 120, rows: 30 })).join("\n");
    expect(wide).toContain("WAITING FOR YOU");
    expect(wide).toContain("JOURNAL");

    const list = plain(render(model, { cols: 70, rows: 30 })).join("\n");
    expect(list).toContain("WAITING FOR YOU");
    expect(list).not.toContain("JOURNAL");

    const card = plain(render(update(model, "enter"), { cols: 70, rows: 30 })).join("\n");
    expect(card).toContain("JOURNAL");
    expect(card).not.toContain("WAITING FOR YOU");
  });

  test("approving a gate needs a confirmation and moves the session out of the waiting group", () => {
    let model = initialModel(DEMO_SESSIONS);
    const id = model.selected;
    model = update(model, "a");
    expect(model.confirm).toBe("approve");
    expect(model.sessions.find((s) => s.id === id)?.status).toBe("waiting");
    expect(update(model, "n").confirm).toBeNull();
    model = update(model, "y");
    expect(model.sessions.find((s) => s.id === id)?.status).toBe("running");
    expect(ordered(model.sessions)[0]?.id).not.toBe(id);
  });

  test("a finished session cannot be approved", () => {
    let model = initialModel(DEMO_SESSIONS);
    for (let i = 0; i < 20; i++) model = update(model, "down");
    expect(model.sessions.find((s) => s.id === model.selected)?.status).toBe("done");
    expect(update(model, "a").confirm).toBeNull();
  });

  test("keys: arrows, enter, escape and ctrl-c are named", () => {
    expect(keyName("\u001b[A")).toBe("up");
    expect(keyName("\r")).toBe("enter");
    expect(keyName("\u001b")).toBe("escape");
    expect(keyName("\u0003")).toBe("ctrl-c");
    expect(keyName("a")).toBe("a");
  });
});
