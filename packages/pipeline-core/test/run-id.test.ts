import { describe, expect, test } from "bun:test";
import { isRunId, RUN_ID_PATTERN } from "../src/run-id";

// Mirrors newRunId in @kodel-ai/local, which pipeline-core must not import.
const makeRunId = (now: number, suffix: number): string =>
  `r_${now.toString(36).padStart(9, "0")}_${suffix.toString(36).padStart(4, "0")}`;

describe("isRunId", () => {
  test("accepts the ids that newRunId makes", () => {
    expect(isRunId(makeRunId(0, 0))).toBe(true);
    expect(isRunId(makeRunId(1_000, 36 ** 4 - 1))).toBe(true);
    expect(isRunId(makeRunId(Date.now(), 12345))).toBe(true);
    expect(isRunId("r_000000000_0000")).toBe(true);
    expect(isRunId("r_zzzzzzzzz_zzzz")).toBe(true);
  });

  test("rejects path traversal", () => {
    for (const value of [
      "..",
      ".",
      "../r_000000000_0000",
      "r_000000000_0000/..",
      "r_000000000_0000/x",
      "r_000000000_0000\\x",
      "%2e%2e",
      "r_000000000_0000\0",
    ]) {
      expect(isRunId(value)).toBe(false);
    }
  });

  test("rejects the wrong case", () => {
    for (const value of [
      "R_000000000_0000",
      "r_00000000A_0000",
      "r_000000000_000A",
      "r_ZZZZZZZZZ_ZZZZ",
    ]) {
      expect(isRunId(value)).toBe(false);
    }
  });

  test("rejects the wrong length", () => {
    for (const value of [
      "",
      "r__",
      "r_00000000_0000",
      "r_0000000000_0000",
      "r_000000000_000",
      "r_000000000_00000",
    ]) {
      expect(isRunId(value)).toBe(false);
    }
  });

  test("rejects trailing and leading junk", () => {
    for (const value of [
      "r_000000000_0000\n",
      "r_000000000_0000 ",
      "r_000000000_0000/",
      " r_000000000_0000",
      "xr_000000000_0000",
      "r_000000000_0000r_000000000_0000",
    ]) {
      expect(isRunId(value)).toBe(false);
    }
  });
});

describe("RUN_ID_PATTERN", () => {
  test("is not global or sticky, so repeated checks agree", () => {
    expect(RUN_ID_PATTERN.global).toBe(false);
    expect(RUN_ID_PATTERN.sticky).toBe(false);
    for (let i = 0; i < 3; i++) {
      expect(RUN_ID_PATTERN.test("r_000000000_0000")).toBe(true);
      expect(RUN_ID_PATTERN.lastIndex).toBe(0);
    }
  });
});
