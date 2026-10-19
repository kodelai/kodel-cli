import { describe, expect, test } from "bun:test";
import { renderDeep, renderTemplate } from "../src";

const ctx = { task: "добавить лимит попыток" };

describe("renderTemplate", () => {
  test("fills the task and its slug", () => {
    expect(renderTemplate("do {{task}}", ctx)).toBe("do добавить лимит попыток");
    expect(renderTemplate("docs/plans/{{task.slug}}.md", ctx)).toBe(
      "docs/plans/dobavit_limit_popytok.md",
    );
    expect(renderTemplate("{{ task.slug }}", ctx)).toBe("dobavit_limit_popytok");
  });

  test("fills every occurrence", () => {
    expect(renderTemplate("{{task.slug}}/{{task.slug}}", { task: "a b" })).toBe("a_b/a_b");
  });

  test("a backslash keeps a literal {{", () => {
    expect(renderTemplate("keep \\{{task}} as is, fill {{task.slug}}", { task: "x" })).toBe(
      "keep {{task}} as is, fill x",
    );
  });

  test("unknown placeholders are left as written", () => {
    expect(renderTemplate("{{nope}}", ctx)).toBe("{{nope}}");
  });

  test("the task text is inserted verbatim, even if it looks like a placeholder", () => {
    expect(renderTemplate("{{task}}", { task: "{{task.slug}}" })).toBe("{{task.slug}}");
  });
});

describe("renderDeep", () => {
  test("renders strings inside arrays and objects, leaves other values alone", () => {
    const value = {
      paths: ["docs/{{task.slug}}.md"],
      nested: { text: "{{task}}", n: 3, flag: true, none: null },
    };
    expect(renderDeep(value, { task: "a b" })).toEqual({
      paths: ["docs/a_b.md"],
      nested: { text: "a b", n: 3, flag: true, none: null },
    });
  });

  test("does not modify its input", () => {
    const value = { p: ["{{task}}"] };
    renderDeep(value, { task: "x" });
    expect(value).toEqual({ p: ["{{task}}"] });
  });
});
