import { expect, test } from "bun:test";
import { BASELINE_FORMAT, MAX_SUPPORTED_FORMAT } from "../src";

test("t12: absence of a version means v1 forever, whatever the engine supports", () => {
  expect(BASELINE_FORMAT).toBe(1);
  expect(MAX_SUPPORTED_FORMAT).toBeGreaterThanOrEqual(BASELINE_FORMAT);
});
