import { describe, expect, test } from "bun:test";
import { renderContextOf, renderDeep, renderTemplate } from "../src";

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

describe("the placeholders a run gives", () => {
  const run = { slug: "pipeline-version-field", startDate: "2026-10-20" };

  test("{{run.slug}} and {{run.start_date}} are filled, with or without spaces", () => {
    expect(
      renderTemplate("docs/plans/{{run.start_date}}-{{ run.slug }}.md", { task: "t", run }),
    ).toBe("docs/plans/2026-10-20-pipeline-version-field.md");
  });

  test("without a run they stay as written, so a dry run shows where they go", () => {
    expect(renderTemplate("{{run.slug}} {{run.start_date}}", { task: "t" })).toBe(
      "{{run.slug}} {{run.start_date}}",
    );
  });

  test("renderDeep fills them inside values", () => {
    expect(renderDeep({ paths: ["docs/{{run.slug}}.md"] }, { task: "t", run })).toEqual({
      paths: ["docs/pipeline-version-field.md"],
    });
  });

  test("a task that looks like a placeholder is not filled again", () => {
    expect(renderTemplate("{{task}}", { task: "{{run.slug}}", run })).toBe("{{run.slug}}");
  });

  test("renderContextOf uses the stored slug and the day the run started", () => {
    const context = renderContextOf({
      task: "t",
      slug: "stored",
      startedAt: Date.UTC(2026, 9, 20, 23, 30),
    });
    expect(context).toEqual({ task: "t", run: { slug: "stored", startDate: "2026-10-20" } });
  });

  test("a run from before it had a slug reads as the name its task would have given", () => {
    const context = renderContextOf({ task: "Fix login", startedAt: Date.UTC(2026, 0, 2) });
    expect(context.run).toEqual({ slug: "fix-login", startDate: "2026-01-02" });
  });
});
