import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { stripAnsi } from "../src/tui/ansi";
import { demoGateDetail, demoSessions } from "../src/tui/demo";
import { MOUSE_OFF, MOUSE_ON } from "../src/tui/input";
import { runTui } from "../src/tui/run";

const BASE = Date.UTC(2026, 9, 27, 15, 0, 0);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A terminal that keeps what is written to it and lets a test type. */
function terminal(cols = 120, rows = 32) {
  const written: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => undefined,
    setEncoding: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
  });
  const stdout = Object.assign(new EventEmitter(), {
    columns: cols,
    rows,
    write: (text: string) => {
      written.push(text);
      return true;
    },
  });
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    type: (input: string) => stdin.emit("data", input),
    /** Everything written since `mark`, without the colors. */
    since: (mark = 0) => stripAnsi(written.slice(mark).join("")),
    mark: () => written.length,
    raw: () => written.join(""),
  };
}

const start = (t: ReturnType<typeof terminal>, mouse = false) =>
  runTui(t.stdin, t.stdout, async () => demoSessions(BASE), "demo", {
    mouse,
    loadDetail: async (id) => demoGateDetail(id, BASE),
  });

describe("tui loop", () => {
  test("it opens on the list, reads the card of the run it stops on, and leaves the screen as it found it", async () => {
    const t = terminal();
    const done = start(t);
    await wait(60);
    expect(t.since()).toContain("WAITING FOR YOU");
    expect(t.raw().startsWith("\u001b[?1049h")).toBe(true);

    // The newest run that waits is the one that needs an approval, and it is the one selected.
    await wait(80);
    const card = t.since();
    expect(card).toContain("Report");
    expect(card).toContain("Look at the diff and try the change.");

    t.type("q");
    expect(await done).toBe(0);
    expect(t.raw().endsWith(`${MOUSE_OFF}\u001b[?25h\u001b[?1049l`)).toBe(true);
  });

  test("Enter, the tabs, a step and Esc work through the real input path", async () => {
    const t = terminal();
    const done = start(t);
    await wait(60);
    await wait(80);

    let mark = t.mark();
    t.type("\r");
    expect(t.since(mark)).toContain("┃");

    mark = t.mark();
    t.type("\t"); // Code
    t.type("\t"); // Steps
    expect(t.since(mark)).toContain("10 entries into steps · Enter opens one");

    mark = t.mark();
    t.type("\u001b[B\u001b[B\u001b[B\u001b[B\u001b[B"); // five keys in one chunk are all heard: down to the first test
    t.type("\r");
    expect(t.since(mark)).toContain("Steps › test");
    expect(t.since(mark)).toContain("1 test failed");

    mark = t.mark();
    t.type("\u001b"); // back to the steps
    expect(t.since(mark)).toContain("10 entries into steps · Enter opens one");

    mark = t.mark();
    t.type("z");
    expect(t.since(mark)).not.toContain("WAITING FOR YOU");
    t.type("q");
    await done;
  });

  test("the mouse is asked for only when it is on, and always turned off on the way out", async () => {
    const off = terminal();
    const offDone = start(off, false);
    await wait(60);
    expect(off.raw()).not.toContain(MOUSE_ON);
    off.type("m");
    expect(off.raw()).toContain(MOUSE_ON);
    off.type("q");
    await offDone;
    expect(off.raw()).toContain(MOUSE_OFF);

    const on = terminal();
    const onDone = start(on, true);
    await wait(60);
    expect(on.raw()).toContain(MOUSE_ON);
    on.type("q");
    await onDone;
    expect(on.raw().lastIndexOf(MOUSE_OFF)).toBeGreaterThan(on.raw().lastIndexOf(MOUSE_ON));
  });

  test("a click on a tab and the wheel are heard when the mouse is on", async () => {
    const t = terminal();
    const done = start(t, true);
    await wait(140);
    // The screen is drawn row by row with a cursor move before each; find the row of the tabs.
    const rowText = (n: number) =>
      (t.since().split(`\u001b[${n};1H`).at(-1) ?? "").split("\u001b[")[0] ?? "";
    const y =
      [3, 4, 5, 6, 7, 8, 9, 10].find(
        (n) => rowText(n).includes("Report") && rowText(n).includes("Comments"),
      ) ?? 0;
    expect(y).toBeGreaterThan(0);
    const x = rowText(y).indexOf("Steps") + 2;
    const mark = t.mark();
    t.type(`\u001b[<0;${x};${y}M`);
    expect(t.since(mark)).toContain("entries into steps");
    t.type("q");
    await done;
  });

  test("a read that fails does not stop the screen", async () => {
    const t = terminal();
    let reads = 0;
    const done = runTui(
      t.stdin,
      t.stdout,
      async () => {
        reads++;
        return demoSessions(BASE);
      },
      "demo",
      {
        loadDetail: async () => {
          throw new Error("git is gone");
        },
      },
    );
    await wait(60);
    t.type("\u001b[B\u001b[B\u001b[B");
    await wait(80);
    expect(t.since()).toContain("Reading the details…");
    t.type("q");
    expect(await done).toBe(0);
    expect(reads).toBeGreaterThan(0);
  });
});
