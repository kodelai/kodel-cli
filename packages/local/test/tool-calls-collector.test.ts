import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoryEvent, ReadOptions, SessionRef } from "@kodel-ai/pipeline-core";
import { ClaudeLogBuilder, installClaudeSession } from "../../testkit/src";
import { claudeCodeCollector } from "../src/history";
import {
  errorTypeOf,
  TOOL_PREVIEW_MAX_JSON,
  type ToolErrorType,
} from "../src/history/claude-code/normalize";

const MARKER = join(".kodel", "config.yaml");
const SESSION = "44444444-4444-4444-8444-444444444444";

let base: string;
let configDir: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "kodel-tool-calls-collector-")));
  configDir = join(base, "claude");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const root = join(base, "p");
  await mkdir(join(root, ".kodel"), { recursive: true });
  await writeFile(join(root, MARKER), "version: 1\n");
  return root;
}

async function readAll(build: (log: ClaudeLogBuilder) => void, options: ReadOptions = {}) {
  const root = await project();
  const log = new ClaudeLogBuilder({ sessionId: SESSION, cwd: root });
  build(log);
  await log.install(configDir);
  const collector = claudeCodeCollector({ configDir });
  const ref = (await collector.locate(root)).find((r) => r.session_id === SESSION) as SessionRef;
  expect(ref).toBeDefined();
  const events: HistoryEvent[] = [];
  for await (const event of collector.read(ref, undefined, options)) events.push(event);
  return events;
}

const calls = (events: HistoryEvent[]) => events.filter((e) => e.kind === "tool_call");
const results = (events: HistoryEvent[]) => events.filter((e) => e.kind === "tool_result");

describe("tool call detail of the Claude Code reader (TASK-ZKRH)", () => {
  // The shapes are the ones real logs of this project hold (counted from 80 session files).
  test.each([
    ["PreToolUse:Bash hook error: direct edit of the config", "hook_blocked"],
    ["PreToolUse:Write hook error: [guard] blocked", "hook_blocked"],
    ["Permission for this action was denied by the auto mode classifier", "denied"],
    ["Permission to use Bash with command git push has been denied.", "denied"],
    [
      "<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>",
      "denied",
    ],
    ["The user doesn't want to proceed with this tool use. The tool use was rejected", "denied"],
    ["[Request interrupted by user for tool use]", "interrupted"],
    ["MCP error -32602: Input validation error: Invalid arguments for tool pipeline_x", "error"],
    ['{ "ok": false, "code": "MISSING_REQUIRED_VALUE", "message": "the report" }', "error"],
    ["<tool_use_error>Error: No such tool available: Grep</tool_use_error>", "error"],
    ["Exit code 1\nTraceback (most recent call last):", "error"],
    // Only the start of the text decides: a mention later in the text never gives another value.
    ["Exit code 2\nPermission to use Bash was denied earlier", "error"],
    ["Shell command failed: the hook error of PreToolUse:Bash", "error"],
    ["", "error"],
  ] as [string, ToolErrorType][])("zkrh_error_type_real_shapes: %j is %s", (text, expected) => {
    expect(errorTypeOf(text)).toBe(expected);
  });

  test("zkrh_tool_detail_is_carried", async () => {
    const events = await readAll(
      (log) => {
        log
          .user("go")
          .call("m1", { id: "toolu_a", name: "Bash", input: { command: "ls -la" } })
          .result("toolu_a", "PreToolUse:Bash hook error: blocked", true)
          .call("m2", { id: "toolu_b", name: "Edit", input: { file_path: "/x" } })
          .result("toolu_b", "[Request interrupted by user for tool use]", true)
          .call("m3", { id: "toolu_c", name: "Read", input: { file_path: "/y" } })
          .result("toolu_c", "fine")
          .say("m4", "done");
      },
      { toolDetail: true },
    );
    const byId = (id: string) => calls(events).find((e) => e.kind === "tool_call" && e.id === id);
    expect(byId("toolu_a")).toMatchObject({
      input_bytes: Buffer.byteLength(JSON.stringify({ command: "ls -la" })),
    });
    const failed = results(events).filter((e) => e.kind === "tool_result" && !e.ok);
    expect(failed.map((e) => (e.kind === "tool_result" ? e.error_type : undefined))).toEqual([
      "hook_blocked",
      "interrupted",
    ]);
    const ok = results(events).find((e) => e.kind === "tool_result" && e.id === "toolu_c");
    expect(ok).toBeDefined();
    expect(ok && "error_type" in ok).toBe(false);
  });

  test("zkrh_default_options_leave_new_fields_out_even_when_the_log_has_them", async () => {
    const events = await readAll((log) => {
      log
        .user("go")
        .call("m1", { id: "toolu_a", name: "Bash", input: { command: "ls" } })
        .result("toolu_a", "Exit code 1", true)
        .say("m2", "done");
    });
    for (const event of calls(events)) expect("input_bytes" in event).toBe(false);
    for (const event of results(events)) expect("error_type" in event).toBe(false);
  });

  test("zkrh_text_mentioning_denied_or_interrupted_in_ok_result_stays_ok", async () => {
    const events = await readAll(
      (log) => {
        log
          .user("go")
          .call("m1", { id: "toolu_a", name: "Read", input: { file_path: "/z" } })
          .result("toolu_a", "[Request interrupted by user for tool use] is a string in the file")
          .say("m2", "done");
      },
      { toolDetail: true },
    );
    const result = results(events)[0];
    expect(result).toMatchObject({ kind: "tool_result", ok: true });
    expect(result && "error_type" in result).toBe(false);
  });

  test("zkrh_value_over_256kb_skips_preview_keeps_size", async () => {
    const big = "x".repeat(TOOL_PREVIEW_MAX_JSON + 10);
    const events = await readAll(
      (log) => {
        log
          .user("go")
          .call("m1", { id: "toolu_big", name: "Write", input: { content: big } })
          .result("toolu_big", "ok")
          .call("m2", { id: "toolu_small", name: "Write", input: { content: "tiny" } })
          .result("toolu_small", "ok")
          .say("m3", "done");
      },
      { toolDetail: true, capture: { caps: { tool_input: 4000 } } },
    );
    const byId = (id: string) => calls(events).find((e) => e.kind === "tool_call" && e.id === id);
    const bigCall = byId("toolu_big");
    const smallCall = byId("toolu_small");
    expect(bigCall && "input_preview" in bigCall).toBe(false);
    expect(bigCall).toMatchObject({
      input_bytes: Buffer.byteLength(JSON.stringify({ content: big })),
    });
    expect(smallCall && "input_preview" in smallCall).toBe(true);
  });

  test("zkrh_secret_straddling_the_preview_cut_is_redacted", async () => {
    // The preview is redacted before it is cut, so the part of a token that survives the cut is never a prefix of it.
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const command = `${"a".repeat(30)} export TOKEN=${token}`;
    const events = await readAll(
      (log) => {
        log
          .user("go")
          .call("m1", { id: "toolu_a", name: "Bash", input: { command } })
          .result("toolu_a", "ok")
          .say("m2", "done");
      },
      { toolDetail: true, capture: { caps: { tool_input: 60 } } },
    );
    const call = calls(events)[0];
    const preview = call && call.kind === "tool_call" ? (call.input_preview ?? "") : "";
    expect(preview.length).toBeGreaterThan(0);
    expect(preview).not.toContain("ghp_");
    expect(preview).not.toContain(token.slice(0, 12));
  });

  test("zkrh_saved_real_session_matches_raw_tool_use_ids", async () => {
    // The saved session (and its subagents) is read for its raw tool_use and tool_result ids with none of the collector's code;
    // what this shows in CI is that the reader loses and adds no call and no result. The ids in the stored rows are hashes of
    // these (`rowId`), so the pass cannot lose one either that the reader gives.
    const FIXTURE = fileURLToPath(
      new URL("../../../fixtures/history/claude-code/v2.1.306/", import.meta.url),
    );
    const root = await project();
    await installClaudeSession({ configDir, cwd: root });
    const files = [
      join(FIXTURE, "session.jsonl"),
      ...(await readdir(join(FIXTURE, "subagents")))
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => join(FIXTURE, "subagents", n)),
    ];
    const uses = new Set<string>();
    const results = new Set<string>();
    for (const file of files) {
      for (const line of (await readFile(file, "utf8")).split("\n")) {
        if (line.trim() === "") continue;
        let entry: { message?: { content?: unknown } };
        try {
          entry = JSON.parse(line) as { message?: { content?: unknown } };
        } catch {
          // the saved session has a line that is not JSON on purpose; the reader skips it too
          continue;
        }
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content as { type?: string; id?: string; tool_use_id?: string }[]) {
          if (block.type === "tool_use" && block.id !== undefined) uses.add(block.id);
          if (block.type === "tool_result" && block.tool_use_id !== undefined) {
            results.add(block.tool_use_id);
          }
        }
      }
    }
    expect(uses.size).toBeGreaterThan(0);
    const collector = claudeCodeCollector({ configDir });
    const refs = await collector.locate(root);
    const seenCalls = new Set<string>();
    const seenResults = new Set<string>();
    for (const ref of refs) {
      for await (const event of collector.read(ref, undefined, { toolDetail: true })) {
        if (event.kind === "tool_call") seenCalls.add(event.id);
        if (event.kind === "tool_result") seenResults.add(event.id);
      }
    }
    expect([...seenCalls].sort()).toEqual([...uses].sort());
    expect([...seenResults].sort()).toEqual([...results].sort());
  });
});
