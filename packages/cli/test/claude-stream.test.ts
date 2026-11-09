/**
 * The parser of `claude -p --output-format stream-json` (TASK-9PNS): one plain line per event for the
 * card, and the session id. The fixture has the shape `claude` 2.1.x writes (the events the live harness
 * reads: `system/init`, `assistant`, `user`, `result`); the broken lines are built here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIGEST_LINES, digest, sessionIdOf, UNSHOWN_EVENT } from "../src/claude-stream";

const FIXTURE = readFileSync(
  join(import.meta.dir, "fixtures", "stream-json", "session.jsonl"),
  "utf8",
);
const ID = "7f3b2a9c-1d4e-4f6a-9b8c-0d1e2f3a4b5c";

const line = (event: Record<string, unknown>) => JSON.stringify(event);
const init = (sessionId: string, tools: string[] = []) =>
  line({ type: "system", subtype: "init", session_id: sessionId, tools });
const result = (fields: Record<string, unknown>) => line({ type: "result", ...fields });

describe("task_9pns the stream-json parser", () => {
  test("task_9pns_stream_parser_fixture", () => {
    const lines = digest(FIXTURE);
    expect(lines).toEqual([
      "init · 26 tools (kodel 15)",
      "> I'll drive the run: first I ask the engine for the next step.",
      "→ pipeline_next_step",
      '← ok: {"node":{"slug":"write","attempt":1,"prompt":"Create the file hello.txt"}}',
      "→ Bash: printf hello > hello.txt && git status --short",
      "← ok: ?? hello.txt",
      "→ Edit: /tmp/project/.kodel/pipelines/dev.yaml",
      "← error: Permission to use Edit has been denied: Edit(.kodel/pipelines/**)",
      "> The step is done; the run waits for your decision at «approve». I end my turn here.",
      "result: ok · 12 turns · 3m 20s",
    ]);
    // Never a cost.
    expect(lines.join("\n")).not.toContain("0.1234");
    expect(lines.join("\n")).not.toContain("usd");
    expect(DIGEST_LINES).toBe(8);
  });

  test("task_9pns_stream_parser_built_lines", () => {
    const secret = "this text must never show";
    // A malformed line after the first: one line for every such event, and its text nowhere.
    const malformed = [init(ID), `{"type":"assistant", broken ${secret}`, result({})].join("\n");
    expect(digest(malformed)).toEqual(["init · 0 tools (kodel 0)", UNSHOWN_EVENT, "result: ok"]);
    expect(digest(malformed).join("\n")).not.toContain(secret);
    // An unknown type is the same line, once for the whole digest.
    const unknown = [init(ID), line({ type: "rate_limit_event" }), line({ type: "whatever" })].join(
      "\n",
    );
    expect(digest(unknown)).toEqual(["init · 0 tools (kodel 0)", UNSHOWN_EVENT]);
    // A line far over the ring: nothing of it shows.
    const huge = `{"type":"assistant","message":{"content":[{"type":"text","text":"${"x".repeat(300 * 1024)}"}]}}`;
    expect(digest(`${init(ID)}\n${huge.slice(0, 100)}`)).toEqual([
      "init · 0 tools (kodel 0)",
      UNSHOWN_EVENT,
    ]);
    // A tail starts mid-event: its first line is skipped silently; the same text as a second line is not.
    const cut = `son","text":"middle of an event"}]}}`;
    expect(digest(`${cut}\n${result({})}`)).toEqual(["result: ok"]);
    expect(digest(`${init(ID)}\n${cut}\n${result({})}`)).toEqual([
      "init · 0 tools (kodel 0)",
      UNSHOWN_EVENT,
      "result: ok",
    ]);
    // A tail cut inside a UTF-8 character: no replacement character in the digest.
    const bytes = Buffer.from(
      `${line({ type: "assistant", message: { content: [{ type: "text", text: "héllo" }] } })}\n${result({})}`,
    );
    const inside = bytes.subarray(bytes.indexOf("é") + 1).toString("utf8");
    expect(inside.startsWith("�")).toBe(true);
    expect(digest(inside).join("")).not.toContain("�");
    // `result` without the numbers is `result: ok`; an error is said.
    expect(digest(result({}))).toEqual(["result: ok"]);
    expect(digest(result({ is_error: true, num_turns: 1 }))).toEqual(["result: error · 1 turn"]);
    // Every line is one line.
    const multi = line({
      type: "assistant",
      message: { content: [{ type: "text", text: "first\nsecond\r\nthird" }] },
    });
    expect(digest(multi)).toEqual(["> first second third"]);
  });

  test("task_9pns_stream_parser_session_id_from_result_then_init", () => {
    const other = "11111111-2222-4333-8444-555555555555";
    expect(sessionIdOf(FIXTURE)).toBe(ID);
    expect(sessionIdOf(init(other))).toBe(other);
    expect(sessionIdOf(`${init(other)}\n${result({ session_id: ID })}`)).toBe(ID);
    expect(sessionIdOf(`${init(ID)}\n${result({})}`)).toBe(ID);
    expect(sessionIdOf(`${init("not-a-uuid")}\n${result({ session_id: 42 })}`)).toBeUndefined();
    expect(sessionIdOf("")).toBeUndefined();
    expect(sessionIdOf("garbage\nmore garbage")).toBeUndefined();
  });

  test("task_9pns_stream_parser_resume_lines", () => {
    const other = "11111111-2222-4333-8444-555555555555";
    expect(digest(init(ID), { resumed: { session: 2, sessionId: ID } })).toEqual([
      "· resumed (session 2)",
      "init · 0 tools (kodel 0)",
    ]);
    expect(digest(init(other), { resumed: { session: 2, sessionId: ID } })).toEqual([
      "· resumed (session 2)",
      "init · 0 tools (kodel 0)",
      "· session id changed",
    ]);
  });
});
