import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  cleanExecutorText,
  clientOf,
  MAX_EXECUTOR_TEXT,
  sameExecutor,
  sourced,
  toolsFingerprint,
} from "../src";
import { SERVER_INSTRUCTIONS, serverInstructions, TOOLS } from "../src/mcp";

describe("values from outside the engine", () => {
  test("t5btp_control_characters_go_and_the_length_is_capped", () => {
    expect(cleanExecutorText("a\u0000b\u001b[2Jc\nd e")).toBe("ab[2Jcde");
    expect(cleanExecutorText("x".repeat(1_000_000))?.length).toBe(MAX_EXECUTOR_TEXT);
  });

  test("t5btp_nothing_left_after_cleaning_is_no_value", () => {
    expect(cleanExecutorText("\u0000 \n")).toBeUndefined();
    expect(cleanExecutorText(42)).toBeUndefined();
    expect(cleanExecutorText(undefined)).toBeUndefined();
  });

  test("t5btp_a_caller_becomes_an_observed_client_and_a_nameless_one_becomes_nothing", () => {
    expect(clientOf({ name: "claude-code", version: "2.1.0" })).toEqual({
      value: { name: "claude-code", version: "2.1.0" },
      source: "observed",
    });
    expect(clientOf({ name: "", version: "1" })).toBeUndefined();
    expect(clientOf(undefined)).toBeUndefined();
  });

  test("t5btp_every_value_carries_its_source", () => {
    expect(sourced("m", "derived")).toEqual({ value: "m", source: "derived" });
  });

  test("t5btp_two_records_are_the_same_when_they_say_the_same_in_any_key_order", () => {
    const a = { client: sourced({ name: "a", version: "1" }, "observed") };
    const b = { client: { source: "observed" as const, value: { version: "1", name: "a" } } };
    expect(sameExecutor(a, b)).toBe(true);
    expect(sameExecutor(a, {})).toBe(false);
    expect(sameExecutor(undefined, undefined)).toBe(true);
  });
});

describe("what the agent is served", () => {
  test("t5btp_the_tools_fingerprint_changes_when_a_description_or_an_argument_changes", () => {
    const base = toolsFingerprint(TOOLS);
    expect(toolsFingerprint(TOOLS)).toBe(base);
    const [first, ...rest] = TOOLS;
    if (!first) throw new Error("no tools");
    expect(
      toolsFingerprint([{ ...first, description: `${first.description}!` }, ...rest]),
    ).not.toBe(base);
    expect(
      toolsFingerprint([
        { ...first, shape: { ...first.shape, extra: z.string().optional() } },
        ...rest,
      ]),
    ).not.toBe(base);
    expect(
      toolsFingerprint([
        { ...first, shape: { ...first.shape, extra: z.string().optional().describe("one") } },
        ...rest,
      ]),
    ).not.toBe(
      toolsFingerprint([
        { ...first, shape: { ...first.shape, extra: z.string().optional().describe("two") } },
        ...rest,
      ]),
    );
  });

  test("t5btp_the_instructions_differ_by_what_the_server_offers", () => {
    expect(serverInstructions({ dialog: true })).not.toBe(SERVER_INSTRUCTIONS);
  });
});
