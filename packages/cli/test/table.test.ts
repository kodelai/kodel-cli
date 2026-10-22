import { describe, expect, test } from "bun:test";
import { formatTable } from "../src/table";

describe("formatTable", () => {
  test("pads every column but the last to its widest cell, header included", () => {
    const lines = formatTable(
      ["KEY", "STATUS", "TITLE"],
      [
        ["KDL-1111", "todo", "A"],
        ["KDL-2", "progress", "B  longer"],
      ],
      true,
    );
    expect(lines).toEqual([
      "KEY       STATUS    TITLE",
      "KDL-1111  todo      A",
      "KDL-2     progress  B  longer",
    ]);
  });

  test("leaves the header out and the widths come from the rows", () => {
    expect(formatTable(["LONG-HEADER", "X"], [["a", "b"]], false)).toEqual(["a  b"]);
  });

  test("width is counted in code points", () => {
    const lines = formatTable(
      ["A", "B"],
      [
        ["é€", "x"],
        ["abc", "y"],
      ],
      true,
    );
    expect(lines).toEqual(["A    B", "é€   x", "abc  y"]);
  });

  test("no trailing spaces when the last cell is empty", () => {
    expect(formatTable(["A", "B"], [["x", ""]], true)).toEqual(["A  B", "x"]);
  });
});
