import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { parsePipeline } from "../src";

const dir = new URL("../../../.kodel/pipelines/", import.meta.url);

describe("the pipelines we run on this repository", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));

  test("there is at least one", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`${file} is a valid pipeline`, () => {
      expect(() => parsePipeline(readFileSync(new URL(file, dir), "utf8"))).not.toThrow();
    });
  }
});
