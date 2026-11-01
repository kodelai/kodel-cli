import { describe, expect, test } from "bun:test";
import { fit, neutralize, visibleLength, wrapText } from "../src/tui/ansi";
import { demoSessions } from "../src/tui/demo";
import { demoStats } from "../src/tui/demo-stats";
import { applyInput } from "../src/tui/run";
import { initialModel, type Model, render, takeEffects, update, withStats } from "../src/tui/view";

const ESC = "\u001b";
const BEL = "\u0007";
const SIZE = { cols: 130, rows: 40 };

/** What an agent could put into a file, a report or a reason to act on the terminal of the person reading. */
const HOSTILE = [
  `${ESC}]52;c;ZXZpbA==${BEL}`, // set the clipboard
  `${ESC}]0;gate approved${ESC}\\`, // set the window title, ended by ST
  `${ESC}[2J${ESC}[H`, // clear the screen, go home
  `${ESC}[5A${ESC}[2K`, // up five lines, erase one
  `${ESC}[8m`, // conceal the text that follows
  `${ESC}Pq${ESC}\\`, // a control string
  `${ESC}c`, // reset the terminal
  "\u009b2J", // a C1 control sequence introducer
  "a\rb\bc\u0000d\u007fe",
].join("");

// biome-ignore lint/suspicious/noControlCharactersInRegex: looking for the control characters is the point
const OWN_STYLE = /\u001b\[(?:0|1|2|7|3[1-6])m/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: looking for the control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Every line is free of anything that could act on a terminal, apart from the styles the screens write. */
function expectSafe(lines: string[]) {
  for (const line of lines) {
    expect(line.replace(OWN_STYLE, "")).not.toMatch(CONTROL);
  }
}

describe("neutralize", () => {
  test("text without escapes is not touched", () => {
    expect(neutralize("plain text · ◆ ● ▸3")).toBe("plain text · ◆ ● ▸3");
  });

  test("the styles the screens write stay", () => {
    for (const code of ["0", "1", "2", "7", "31", "32", "33", "34", "35", "36"]) {
      expect(neutralize(`${ESC}[${code}mx`)).toBe(`${ESC}[${code}mx`);
    }
  });

  test("every other style goes: it could hide text, or paint it the colour of the ground", () => {
    for (const code of ["8", "30", "40", "47", "38;5;0", "38;2;0;0;0", "5", "9"]) {
      expect(neutralize(`a${ESC}[${code}mb`)).toBe("ab");
    }
  });

  test("an operating-system command goes, with its end, whichever end it has", () => {
    expect(neutralize(`a${ESC}]52;c;ZXZpbA==${BEL}b`)).toBe("ab");
    expect(neutralize(`a${ESC}]0;title${ESC}\\b`)).toBe("ab");
  });

  test("a control sequence that moves the cursor or erases goes", () => {
    expect(neutralize(`a${ESC}[2J${ESC}[H${ESC}[3;4H${ESC}[K${ESC}[?1049hb`)).toBe("ab");
  });

  test("a control string and a lone escape go", () => {
    expect(neutralize(`a${ESC}Pq${ESC}\\${ESC}cb${ESC}`)).toBe("ab");
  });

  test("control characters of every kind go, and a tab becomes a space", () => {
    expect(neutralize("a\rb\nc\bd\u0000e\u007ff\u009bg\u0090h\ti")).toBe("abcdefgh i");
  });

  test("a hostile text, whole, comes out safe", () => {
    expectSafe([neutralize(`before ${HOSTILE} after`)]);
    expect(neutralize(`before ${HOSTILE} after`)).toContain("before ");
  });
});

describe("fit and wrapText", () => {
  test("fit makes text safe, and the width is what is left", () => {
    const out = fit(`ab${HOSTILE}cd`, 12);
    expectSafe([out]);
    expect(visibleLength(out)).toBe(12);
  });

  test("fit cuts a long hostile text to the width without a loose escape", () => {
    const out = fit(`${HOSTILE}${HOSTILE}x`.repeat(5), 20);
    expectSafe([out]);
    expect(visibleLength(out)).toBe(20);
  });

  test("wrapText makes the words safe", () => {
    expectSafe(wrapText(`one ${HOSTILE} two three`, 10));
  });

  test("a colour that the screen wrote around hostile text is kept", () => {
    expect(fit(`${ESC}[31m${HOSTILE}x${ESC}[0m`, 5)).toContain(`${ESC}[31m`);
  });
});

describe("the screens draw hostile data safely", () => {
  function sessions(): Model {
    const loaded = demoSessions(Date.now());
    const [first, ...rest] = loaded.sessions;
    if (!first) throw new Error("the sample has sessions");
    return initialModel(
      {
        ...loaded,
        sessions: [
          {
            ...first,
            title: `title ${HOSTILE}`,
            step: `step ${HOSTILE}`,
            headline: `headline ${HOSTILE}`,
            prompt: `prompt ${HOSTILE}`,
            reason: `reason ${HOSTILE}`,
          },
          ...rest,
        ],
      },
      "demo",
      Date.now(),
    );
  }

  test("the list and the card of a run", () => {
    const m = sessions();
    expectSafe(render(m, SIZE));
    expectSafe(render(update(m, "enter", SIZE), SIZE));
  });

  test("a reason a step failed, in the Report", () => {
    let m = initialModel(demoSessions(Date.now()), "demo", Date.now());
    m = takeEffects(update(update(m, "4", SIZE), "enter", SIZE))[0];
    const data = demoStats("dev");
    const nodes = data.current.nodes.map((n) =>
      n.node === "impl"
        ? { ...n, failures: [{ source: `from ${HOSTILE}`, reason: `why ${HOSTILE}`, n: 3 }] }
        : n,
    );
    m = withStats(m, "dev", {
      status: "ready",
      data: { ...data, current: { ...data.current, nodes } },
    });
    for (const keys of [[], ["down", "down", "enter"]]) {
      for (const key of keys) m = update(m, key, SIZE);
      expectSafe(render(m, SIZE));
    }
  });

  test("the text of the definition of a version, in the Report", () => {
    let m = initialModel(demoSessions(Date.now()), "demo", Date.now());
    m = takeEffects(update(update(m, "4", SIZE), "enter", SIZE))[0];
    const data = demoStats("dev");
    const definitions = Object.fromEntries(
      Object.entries(data.definitions).map(([key, lines]) => [
        key,
        lines.map((line) => `${line} ${HOSTILE}`),
      ]),
    );
    m = withStats(m, "dev", { status: "ready", data: { ...data, definitions } });
    for (const key of ["down", "down", "right", "down", "down", "enter"]) {
      m = update(m, key, SIZE);
    }
    const tall = { cols: 130, rows: 80 };
    const lines = render(m, tall);
    expect(lines.join("\n")).toContain("WHAT CHANGED SINCE");
    expectSafe(lines);
  });
});

describe("applyInput", () => {
  function typing(): Model {
    const m = initialModel(demoSessions(Date.now()), "demo", Date.now());
    return { ...m, input: { text: "", severity: "major", place: "src/a.ts" } };
  }

  test("text typed goes into the comment", () => {
    const m = applyInput(typing(), "abc", SIZE);
    expect(m.input?.text).toBe("abc");
  });

  test("a paste with a line break ends the comment there, and the rest is not read as keys", () => {
    const m = applyInput(typing(), "first line\nq", SIZE);
    expect(m.input).toBeNull();
    expect(m.quit).toBe(false);
  });

  test("keys after a comment that was ended by hand are read as keys", () => {
    const ended = applyInput(typing(), "x\n", SIZE);
    expect(ended.input).toBeNull();
    expect(applyInput(ended, "q", SIZE).quit).toBe(true);
  });

  test("without a comment, a chunk of keys is read key by key", () => {
    const m = initialModel(demoSessions(Date.now()), "demo", Date.now());
    expect(applyInput(m, "2", SIZE).section).toBe(1);
    expect(applyInput(m, "q", SIZE).quit).toBe(true);
  });
});
