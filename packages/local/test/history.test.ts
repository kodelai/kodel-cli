import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type HistoryEvent,
  historyEventSchema,
  KodelError,
  newReadStats,
  type SessionRef,
} from "@kodel-ai/pipeline-core";
import {
  CLAUDE_FIXTURE,
  CLAUDE_FIXTURE_SESSION,
  claudeFolderName,
  installClaudeSession,
} from "../../testkit/src/history-fixtures";
import {
  claudeCodeCollector,
  defaultHistoryRegistry,
  MAX_LINE_BYTES,
  projectFolderName,
  streamJsonl,
} from "../src/history";
import { SESSIONS_INDEX } from "../src/hooks";

const MARKER = join(".kodel", "config.yaml");
const GOLDEN = fileURLToPath(new URL("../../../fixtures/formats/v1/history/", import.meta.url));

let base: string;
let configDir: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "kodel-history-")));
  configDir = join(base, "claude");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A Kodel project: the committed config is its marker. */
async function project(name: string): Promise<string> {
  const root = join(base, name);
  await mkdir(join(root, ".kodel"), { recursive: true });
  await writeFile(join(root, MARKER), "version: 1\n");
  return root;
}

async function collect(source: AsyncIterable<HistoryEvent>): Promise<HistoryEvent[]> {
  const out: HistoryEvent[] = [];
  for await (const event of source) out.push(event);
  return out;
}

async function lines(
  path: string,
  options?: Parameters<typeof streamJsonl>[1],
): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const value of streamJsonl(path, options)) out.push(value);
  return out;
}

describe("vh9g history: reading JSON Lines as a stream", () => {
  test("vh9g_invalid_lines_are_skipped_and_counted", async () => {
    const path = join(base, "a.jsonl");
    await writeFile(path, '{"a":1}\nnot json\n\n{"b":2}\n');
    const counters = { lines: 0, invalid_lines: 0 };
    expect(await lines(path, { counters })).toEqual([{ a: 1 }, { b: 2 }]);
    expect(counters).toEqual({ lines: 3, invalid_lines: 1 });
  });

  test("vh9g_a_torn_last_line_is_dropped_and_is_not_an_invalid_line", async () => {
    const path = join(base, "a.jsonl");
    await writeFile(path, '{"a":1}\n{"b":');
    const counters = { lines: 0, invalid_lines: 0 };
    expect(await lines(path, { counters })).toEqual([{ a: 1 }]);
    expect(counters.invalid_lines).toBe(0);
  });

  test("vh9g_a_last_line_without_a_newline_that_parses_is_kept", async () => {
    const path = join(base, "a.jsonl");
    await writeFile(path, '{"a":1}\n{"b":2}');
    expect(await lines(path)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("vh9g_a_line_over_the_cap_is_skipped_without_being_held_and_the_next_one_is_read", async () => {
    const path = join(base, "a.jsonl");
    await writeFile(path, `{"big":"${"x".repeat(5000)}"}\n{"ok":1}\n`);
    const counters = { lines: 0, invalid_lines: 0 };
    expect(await lines(path, { maxLineBytes: 1000, counters })).toEqual([{ ok: 1 }]);
    expect(counters).toEqual({ lines: 2, invalid_lines: 1 });
    expect(MAX_LINE_BYTES).toBeGreaterThan(1_000_000);
  });

  test("vh9g_a_line_split_across_chunks_is_joined", async () => {
    const path = join(base, "a.jsonl");
    const value = { text: "é".repeat(300_000) };
    await writeFile(path, `${JSON.stringify(value)}\n${JSON.stringify(value)}\n`);
    expect(await lines(path)).toEqual([value, value]);
  });

  test("vh9g_maxBytes_reads_only_the_head_of_a_file", async () => {
    const path = join(base, "a.jsonl");
    await writeFile(path, `{"a":1}\n${"{}\n".repeat(100_000)}`);
    expect((await lines(path, { maxBytes: 16 })).length).toBeLessThan(10);
  });

  test("vh9g_a_big_log_is_streamed", async () => {
    const path = join(base, "big.jsonl");
    const mb = process.env["KODEL_SLOW_TESTS"] === "1" ? 1024 : 48;
    const chunk = `${`{"type":"user","pad":"${"y".repeat(1000)}"}\n`.repeat(1000)}`;
    const handle = await Bun.file(path).writer();
    for (let i = 0; i < mb; i += 1) handle.write(chunk);
    await handle.end();
    const before = process.memoryUsage().rss;
    let count = 0;
    for await (const _ of streamJsonl(path)) count += 1;
    expect(count).toBe(mb * 1000);
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * 1024 * 1024);
  }, 300_000);
});

describe("vh9g history: the Claude Code reading of a session", () => {
  test("vh9g_a_real_shaped_session_becomes_valid_events_with_duplicates_folded", async () => {
    const root = await project("p");
    await installClaudeSession({ configDir, cwd: root });
    const collector = claudeCodeCollector({ configDir });
    const refs = await collector.locate(root);
    const main = refs.find((r) => r.session_id === CLAUDE_FIXTURE_SESSION);
    expect(main).toBeDefined();
    const stats = newReadStats();
    const events = await collect(collector.read(main as SessionRef, undefined, { stats }));
    for (const event of events) expect(historyEventSchema.safeParse(event).success).toBe(true);

    const usage = events.filter((e) => e.kind === "usage");
    // msg_A is written on three lines (the last one twice): one event with the last usage
    expect(usage.map((e) => e.kind === "usage" && e.message_id)).toEqual([
      "msg_A",
      "msg_B",
      "msg_C",
      "msg_D",
    ]);
    const a = usage[0];
    expect(a).toMatchObject({
      input: 2,
      output: 40,
      cache_read: 100,
      cache_write: 50,
      reasoning: 7,
      semantics: "additive",
    });
    expect(a).toMatchObject({
      request_id: "req_A",
      model: "claude-sonnet-5-5",
      cost: { basis: "unknown" },
    });
    expect(
      events.filter(
        (e) => e.kind === "message" && e.role === "assistant" && e.message_id === "msg_A",
      ),
    ).toHaveLength(1);

    const results = events.filter((e) => e.kind === "tool_result");
    expect(results.map((e) => e.kind === "tool_result" && [e.id, e.ok, e.duration_ms])).toEqual([
      ["toolu_1", true, 2000],
      ["toolu_2", false, 500],
      ["toolu_3", true, 1000],
    ]);
    expect(events.find((e) => e.kind === "tool_call" && e.id === "toolu_2")).toMatchObject({
      name: "mcp__kodel__pipeline_next_step",
      mcp_server: "kodel",
    });
    expect(events.find((e) => e.kind === "subagent")).toMatchObject({
      agent_id: "abc123",
      child_session_id: "agent-abc123",
      description_preview: "Review the change",
    });
    // a meta user line and bookkeeping lines are not messages
    expect(events.filter((e) => e.kind === "message" && e.role === "user")).toHaveLength(1);
    // the system line without a timestamp takes the one before it
    expect(events.find((e) => e.kind === "system")).toMatchObject({
      subtype: "turn_duration",
      detail: "6000ms",
      ts: "2026-10-21T10:00:06.000Z",
    });
    expect(stats).toMatchObject({
      lines: 18,
      invalid_lines: 1,
      skipped_entries: 3,
      profiles: { "cc-2": 15 },
      drift: [],
    });
  });

  test("vh9g_the_normalized_events_match_the_golden_fixture_of_the_format", async () => {
    const root = await project("p");
    await installClaudeSession({ configDir, cwd: root });
    const collector = claudeCodeCollector({ configDir });
    for (const ref of await collector.locate(root)) {
      const text = (await collect(collector.read(ref)))
        // Whether the redactor takes the temporary path for a random token depends on where the
        // test runs (its length, the characters of mkdtemp); the golden holds the redacted form.
        .map((e) =>
          JSON.stringify(e)
            .replaceAll(root, "__CWD__")
            .replace('"cwd":"__CWD__"', '"cwd":"[REDACTED:high-entropy]"'),
        )
        .join("\n");
      const file = join(
        GOLDEN,
        `claude-code-${ref.session_id === CLAUDE_FIXTURE_SESSION ? "session" : ref.session_id}.events.jsonl`,
      );
      if (process.env["UPDATE_GOLDEN"] === "1") {
        await mkdir(GOLDEN, { recursive: true });
        await writeFile(file, `${text}\n`);
      }
      expect(`${text}\n`).toBe(await readFile(file, "utf8"));
    }
  });

  test("vh9g_a_torn_last_line_of_a_log_being_written_is_fine", async () => {
    const root = await project("p");
    const log = await installClaudeSession({ configDir, cwd: root, subagents: false });
    const collector = claudeCodeCollector({ configDir });
    const [ref] = await collector.locate(root);
    const before = (await collect(collector.read(ref as SessionRef))).length;
    await appendFile(
      log,
      '{"type":"assistant","timestamp":"2026-10-21T10:00:09.000Z","message":{"id":"msg_T',
    );
    expect((await collect(collector.read(ref as SessionRef))).length).toBe(before);
  });

  test("vh9g_the_events_are_cut_by_a_window_without_changing_their_seq", async () => {
    const root = await project("p");
    await installClaudeSession({ configDir, cwd: root, subagents: false });
    const collector = claudeCodeCollector({ configDir });
    const [ref] = await collector.locate(root);
    const all = await collect(collector.read(ref as SessionRef));
    const window = await collect(
      collector.read(ref as SessionRef, {
        from: "2026-10-21T10:00:04.000Z",
        to: "2026-10-21T10:00:05.000Z",
      }),
    );
    expect(window).toEqual(
      all.filter((e) => e.ts >= "2026-10-21T10:00:04.000Z" && e.ts <= "2026-10-21T10:00:05.000Z"),
    );
    expect(window[0]?.seq).toBeGreaterThan(1);
  });

  test("vh9g_a_result_whose_call_is_before_the_window_is_kept_without_a_duration", async () => {
    const root = await project("p");
    await installClaudeSession({ configDir, cwd: root, subagents: false });
    const log = join(
      configDir,
      "projects",
      claudeFolderName(root),
      `${CLAUDE_FIXTURE_SESSION}.jsonl`,
    );
    const kept = (await readFile(log, "utf8"))
      .split("\n")
      .filter((l) => !l.includes('"toolu_1","name"'));
    await writeFile(log, kept.join("\n"));
    const collector = claudeCodeCollector({ configDir });
    const [ref] = await collector.locate(root);
    const result = (await collect(collector.read(ref as SessionRef))).find(
      (e) => e.kind === "tool_result" && e.id === "toolu_1",
    );
    expect(result).toBeDefined();
    expect(result && "duration_ms" in result).toBe(false);
  });

  /** A small log of our own in the store: a few lines, the way the agent writes them. */
  async function ownLog(
    root: string,
    lines: object[],
  ): Promise<{ collector: ReturnType<typeof claudeCodeCollector>; ref: SessionRef }> {
    const folder = join(configDir, "projects", claudeFolderName(root));
    await mkdir(folder, { recursive: true });
    const path = join(folder, "own.jsonl");
    await writeFile(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const collector = claudeCodeCollector({ configDir });
    return {
      collector,
      ref: { agent: "claude-code", session_id: "own", project_root: root, path },
    };
  }
  const line = (root: string, type: string, at: string, extra: object) => ({
    type,
    cwd: root,
    version: "2.1.306",
    timestamp: at,
    ...extra,
  });
  const part = (root: string, at: string, output: number, content: object[], id = "msg_S") =>
    line(root, "assistant", at, {
      requestId: `req_${id}`,
      message: {
        id,
        role: "assistant",
        model: "m",
        content,
        usage: { input_tokens: 1, output_tokens: output },
      },
    });

  test("vh9g_a_response_split_by_a_user_line_keeps_its_last_usage_and_its_time", async () => {
    const root = await project("p");
    const { collector, ref } = await ownLog(root, [
      part(root, "2026-10-21T10:00:01.000Z", 5, [
        { type: "tool_use", id: "toolu_a", name: "Bash", input: {} },
      ]),
      line(root, "user", "2026-10-21T10:00:03.000Z", {
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "x" }],
        },
      }),
      line(root, "system", "2026-10-21T10:00:03.500Z", { subtype: "stop_hook_summary" }),
      part(root, "2026-10-21T10:00:04.000Z", 400, [
        { type: "text", text: "the rest of the response" },
      ]),
      part(root, "2026-10-21T10:00:09.000Z", 7, [{ type: "text", text: "next response" }], "msg_T"),
    ]);
    const events = await collect(collector.read(ref));
    const usage = events.filter((e) => e.kind === "usage");
    expect(usage.map((e) => e.kind === "usage" && [e.message_id, e.output])).toEqual([
      ["msg_S", 400],
      ["msg_T", 7],
    ]);
    // the usage has the time of the response's last line and comes before the lines that were written in between
    const at = events.findIndex((e) => e.kind === "usage" && e.message_id === "msg_S");
    expect(events[at]?.ts).toBe("2026-10-21T10:00:04.000Z");
    expect(events.findIndex((e) => e.kind === "tool_result")).toBeGreaterThan(at);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    for (let i = 1; i < events.length; i += 1)
      expect((events[i]?.ts ?? "") >= (events[i - 1]?.ts ?? "")).toBe(true);
  });

  test("vh9g_a_hand_made_ref_cannot_vouch_for_a_log_with_its_cwd", async () => {
    const mine = await project("mine");
    const other = await project("other");
    const log = await installClaudeSession({ configDir, cwd: other, subagents: false });
    const ref: SessionRef = {
      agent: "claude-code",
      session_id: CLAUDE_FIXTURE_SESSION,
      project_root: mine,
      path: log,
      cwd: mine,
    };
    await expect(collect(claudeCodeCollector({ configDir }).read(ref))).rejects.toMatchObject({
      code: "HISTORY_PATH_OUTSIDE_PROJECT",
    });
  });

  test("vh9g_started_ended_and_duration_follow_the_ts_when_the_log_goes_back_in_time", async () => {
    const root = await project("p");
    const { collector, ref } = await ownLog(root, [
      part(root, "2026-10-21T10:00:05.000Z", 3, [
        { type: "tool_use", id: "toolu_a", name: "Bash", input: {} },
      ]),
      line(root, "user", "2026-10-21T10:00:02.000Z", {
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "x" }],
        },
      }),
    ]);
    const events = await collect(collector.read(ref));
    const call = events.find((e) => e.kind === "tool_call");
    const result = events.find((e) => e.kind === "tool_result");
    expect(call).toMatchObject({
      ts: "2026-10-21T10:00:05.000Z",
      started: "2026-10-21T10:00:05.000Z",
    });
    expect(result).toMatchObject({
      ts: "2026-10-21T10:00:05.000Z",
      ended: "2026-10-21T10:00:05.000Z",
      duration_ms: 0,
    });
  });

  test("vh9g_the_stats_are_written_when_the_consumer_stops_early", async () => {
    const root = await project("p");
    await installClaudeSession({ configDir, cwd: root, subagents: false });
    const collector = claudeCodeCollector({ configDir });
    const [ref] = await collector.locate(root);
    const stats = newReadStats();
    for await (const _ of collector.read(ref as SessionRef, undefined, { stats })) break;
    expect(stats.lines).toBeGreaterThan(0);
  });

  test("vh9g_a_secret_in_a_message_does_not_reach_an_event", async () => {
    const root = await project("p");
    const log = await installClaudeSession({ configDir, cwd: root, subagents: false });
    await appendFile(
      log,
      `${JSON.stringify({ type: "user", sessionId: CLAUDE_FIXTURE_SESSION, cwd: root, version: "2.1.306", timestamp: "2026-10-21T10:01:00.000Z", message: { role: "user", content: "use AKIAIOSFODNN7EXAMPLE please" } })}\n`,
    );
    const collector = claudeCodeCollector({ configDir });
    const [ref] = await collector.locate(root);
    expect(JSON.stringify(await collect(collector.read(ref as SessionRef)))).not.toContain(
      "AKIAIOSFODNN7EXAMPLE",
    );
  });
});

describe("vh9g history: versions of the agent", () => {
  test("vh9g_a_version_outside_the_known_range_is_read_by_the_nearest_profile_and_reported", async () => {
    const root = await project("p");
    await installClaudeSession({ configDir, cwd: root, subagents: false, version: "3.4.0" });
    const collector = claudeCodeCollector({ configDir });
    const [ref] = await collector.locate(root);
    const stats = newReadStats();
    const events = await collect(collector.read(ref as SessionRef, undefined, { stats }));
    expect(stats.drift).toEqual([
      { agent_version: "3.4.0", profile: "cc-2", match: "above_known" },
    ]);
    const drift = events.filter((e) => e.kind === "system" && e.subtype === "format_drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      agent_version: "3.4.0",
      detail: "read with profile cc-2 (above_known)",
    });
    expect(events.filter((e) => e.kind === "usage")).toHaveLength(4);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  test("vh9g_a_version_below_the_known_range_is_reported_as_below", async () => {
    const root = await project("p");
    await installClaudeSession({ configDir, cwd: root, subagents: false, version: "1.0.30" });
    const collector = claudeCodeCollector({ configDir });
    const [ref] = await collector.locate(root);
    const stats = newReadStats();
    await collect(collector.read(ref as SessionRef, undefined, { stats }));
    expect(stats.drift[0]).toMatchObject({ agent_version: "1.0.30", match: "below_known" });
  });

  test("vh9g_entries_of_two_versions_in_one_session_are_each_read_and_seq_stays_whole", async () => {
    const root = await project("p");
    const log = await installClaudeSession({ configDir, cwd: root, subagents: false });
    const text = (await readFile(log, "utf8")).replace(
      /"version":"2.1.306"/g,
      (m, offset: number) => (offset > 6000 ? '"version":"2.1.400"' : m),
    );
    await writeFile(log, text);
    const collector = claudeCodeCollector({ configDir });
    const [ref] = await collector.locate(root);
    const stats = newReadStats();
    const events = await collect(collector.read(ref as SessionRef, undefined, { stats }));
    expect(new Set(events.map((e) => e.agent_version))).toEqual(new Set(["2.1.306", "2.1.400"]));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(stats.drift).toEqual([]);
  });

  test("vh9g_entries_without_a_version_use_the_newest_profile_without_a_drift_report", async () => {
    const root = await project("p");
    const log = await installClaudeSession({ configDir, cwd: root, subagents: false });
    await writeFile(log, (await readFile(log, "utf8")).replaceAll(',"version":"2.1.306"', ""));
    const collector = claudeCodeCollector({ configDir });
    const [ref] = await collector.locate(root);
    const stats = newReadStats();
    const events = await collect(collector.read(ref as SessionRef, undefined, { stats }));
    expect(events.filter((e) => e.kind === "usage")).toHaveLength(4);
    expect(stats.drift).toEqual([]);
  });
});

describe("vh9g history: which sessions belong to the project", () => {
  test("vh9g_folder_names_replace_every_character_that_is_not_a_letter_or_a_digit", () => {
    expect(projectFolderName("/Users/a/my proj_1")).toBe("-Users-a-my-proj-1");
    expect(projectFolderName("C:\\Users\\a b\\proj")).toBe("C--Users-a-b-proj");
  });

  test("vh9g_two_projects_side_by_side_the_other_ones_sessions_are_neither_listed_nor_opened", async () => {
    const mine = await project("mine");
    const other = await project("other");
    await installClaudeSession({
      configDir,
      cwd: mine,
      sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
    });
    const foreign = await installClaudeSession({
      configDir,
      cwd: other,
      sessionId: "bbbbbbbb-0000-4000-8000-000000000002",
    });
    // a log that cannot be opened proves that it was not: the listing would fail on it
    if (process.getuid?.() !== 0) await chmod(foreign, 0o000);
    try {
      const refs = await claudeCodeCollector({ configDir }).locate(mine);
      expect(refs.map((r) => r.session_id).sort()).toEqual([
        "aaaaaaaa-0000-4000-8000-000000000001",
        "agent-abc123",
      ]);
    } finally {
      await chmod(foreign, 0o600);
    }
  });

  test("vh9g_a_log_in_the_projects_folder_whose_cwd_is_elsewhere_is_not_a_session_of_the_project", async () => {
    const mine = await project("mine");
    const other = await project("other");
    await installClaudeSession({
      configDir,
      cwd: other,
      folder: claudeFolderName(mine),
      sessionId: "cccccccc-0000-4000-8000-000000000003",
      subagents: false,
    });
    expect(await claudeCodeCollector({ configDir }).locate(mine)).toEqual([]);
  });

  test("vh9g_a_session_of_a_run_worktree_belongs_to_the_project", async () => {
    const root = await project("p");
    const worktree = join(root, ".kodel", "worktrees", "r_1");
    await mkdir(worktree, { recursive: true });
    await installClaudeSession({
      configDir,
      cwd: worktree,
      sessionId: "dddddddd-0000-4000-8000-000000000004",
      subagents: false,
    });
    const refs = await claudeCodeCollector({ configDir }).locate(root);
    expect(refs.map((r) => [r.session_id, r.cwd])).toEqual([
      ["dddddddd-0000-4000-8000-000000000004", worktree],
    ]);
  });

  test("vh9g_a_session_started_in_the_root_that_works_in_a_worktree_is_found_by_where_it_started", async () => {
    const root = await project("p");
    const worktree = join(root, ".kodel", "worktrees", "r_1");
    await mkdir(worktree, { recursive: true });
    const log = await installClaudeSession({ configDir, cwd: root, subagents: false });
    await appendFile(
      log,
      `${JSON.stringify({ type: "user", cwd: worktree, version: "2.1.306", timestamp: "2026-10-21T10:02:00.000Z", message: { role: "user", content: "in the worktree" } })}\n`,
    );
    const [ref] = await claudeCodeCollector({ configDir }).locate(root);
    expect(ref?.cwd).toBe(root);
    const events = await collect(claudeCodeCollector({ configDir }).read(ref as SessionRef));
    expect(events.at(-1)).toMatchObject({ kind: "message", text_preview: "in the worktree" });
  });

  test("vh9g_a_long_project_path_is_found_by_the_prefix_of_its_hashed_folder_name", async () => {
    let root = base;
    for (let i = 0; root.length < 230; i += 1) root = join(root, `${"d".repeat(40)}${i}`);
    await mkdir(join(root, ".kodel"), { recursive: true });
    await writeFile(join(root, MARKER), "version: 1\n");
    const name = claudeFolderName(root);
    expect(name.length).toBeGreaterThan(200);
    await installClaudeSession({
      configDir,
      cwd: root,
      folder: `${name.slice(0, 200)}-1a2b3c`,
      subagents: false,
    });
    expect(await claudeCodeCollector({ configDir }).locate(root)).toHaveLength(1);
  });

  test("vh9g_a_session_started_in_a_subdirectory_or_in_a_removed_worktree_is_found_but_a_sibling_project_is_not", async () => {
    const root = await project("p");
    const sibling = await project("p-two");
    const sub = join(root, "packages", "cli");
    await mkdir(sub, { recursive: true });
    const gone = join(root, ".kodel", "worktrees", "r_gone"); // removed with its run: the directory is not there
    await installClaudeSession({
      configDir,
      cwd: sub,
      sessionId: "10000000-0000-4000-8000-000000000001",
      subagents: false,
    });
    await installClaudeSession({
      configDir,
      cwd: gone,
      sessionId: "20000000-0000-4000-8000-000000000002",
      subagents: false,
    });
    await installClaudeSession({
      configDir,
      cwd: sibling,
      sessionId: "30000000-0000-4000-8000-000000000003",
      subagents: false,
    });
    const refs = await claudeCodeCollector({ configDir }).locate(root);
    expect(refs.map((r) => r.session_id).sort()).toEqual([
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
    ]);
  });

  test("vh9g_subagent_logs_are_found_after_their_parent_and_carry_its_id", async () => {
    const root = await project("p");
    await installClaudeSession({ configDir, cwd: root });
    const collector = claudeCodeCollector({ configDir });
    const refs = await collector.locate(root);
    expect(refs.map((r) => [r.session_id, r.parent_session_id])).toEqual([
      [CLAUDE_FIXTURE_SESSION, undefined],
      ["agent-abc123", CLAUDE_FIXTURE_SESSION],
    ]);
    const child = await collect(collector.read(refs[1] as SessionRef));
    expect(
      child.every(
        (e) => e.parent_session_id === CLAUDE_FIXTURE_SESSION && e.session_id === "agent-abc123",
      ),
    ).toBe(true);
  });

  test("vh9g_with_the_session_index_nothing_is_scanned", async () => {
    const root = await project("p");
    const listed = await installClaudeSession({
      configDir,
      cwd: root,
      sessionId: "eeeeeeee-0000-4000-8000-000000000005",
      subagents: false,
    });
    await installClaudeSession({
      configDir,
      cwd: root,
      sessionId: "ffffffff-0000-4000-8000-000000000006",
      subagents: false,
    });
    const record = (session_id: string, transcript_path: string, agent = "claude-code") =>
      `${JSON.stringify({ session_id, agent, transcript_path, cwd: root, ts: "2026-10-21T10:00:00.000Z" })}\n`;
    const outside = join(base, "outside.jsonl");
    await writeFile(outside, "{}\n");
    await writeFile(
      join(root, SESSIONS_INDEX),
      record("eeeeeeee-0000-4000-8000-000000000005", "/gone.jsonl") +
        record("eeeeeeee-0000-4000-8000-000000000005", listed) +
        record("outside", outside) +
        record("codex-1", listed, "codex"),
    );
    const refs = await claudeCodeCollector({ configDir }).locate(root);
    // the last line of a session wins, a path outside the agent's store and another agent's line are ignored,
    // and the second log in the folder is not found because the index is the answer
    expect(refs.map((r) => r.session_id)).toEqual(["eeeeeeee-0000-4000-8000-000000000005"]);
  });

  test("vh9g_an_index_with_no_line_of_this_agent_leaves_the_scan_on", async () => {
    const root = await project("p");
    await installClaudeSession({
      configDir,
      cwd: root,
      sessionId: "ffffffff-0000-4000-8000-000000000006",
      subagents: false,
    });
    await writeFile(
      join(root, SESSIONS_INDEX),
      `${JSON.stringify({ session_id: "o1", agent: "opencode", cwd: root, ts: "2026-10-21T10:00:00.000Z" })}\n`,
    );
    expect(
      (await claudeCodeCollector({ configDir }).locate(root)).map((r) => r.session_id),
    ).toEqual(["ffffffff-0000-4000-8000-000000000006"]);
  });

  test("vh9g_without_the_index_the_scan_finds_what_the_index_would_not_know", async () => {
    const root = await project("p");
    await installClaudeSession({
      configDir,
      cwd: root,
      sessionId: "ffffffff-0000-4000-8000-000000000006",
      subagents: false,
    });
    expect(
      (await claudeCodeCollector({ configDir }).locate(root)).map((r) => r.session_id),
    ).toEqual(["ffffffff-0000-4000-8000-000000000006"]);
  });

  test("vh9g_a_directory_without_the_kodel_marker_has_no_sessions_and_its_logs_are_not_read", async () => {
    const plain = join(base, "plain");
    await mkdir(plain, { recursive: true });
    const log = await installClaudeSession({ configDir, cwd: plain, subagents: false });
    const collector = claudeCodeCollector({ configDir });
    expect(await collector.locate(plain)).toEqual([]);
    const ref: SessionRef = {
      agent: "claude-code",
      session_id: CLAUDE_FIXTURE_SESSION,
      project_root: plain,
      path: log,
      cwd: plain,
    };
    await expect(collect(collector.read(ref))).rejects.toMatchObject({
      code: "HISTORY_PATH_OUTSIDE_PROJECT",
    });
  });

  test("vh9g_a_project_with_no_claude_folder_has_no_sessions", async () => {
    const root = await project("p");
    expect(await claudeCodeCollector({ configDir: join(base, "nowhere") }).locate(root)).toEqual(
      [],
    );
  });

  test("vh9g_the_default_registry_has_the_claude_code_collector", () => {
    expect(defaultHistoryRegistry({ claudeCode: { configDir } }).agents()).toEqual(["claude-code"]);
  });
});

describe("vh9g history: safety", () => {
  test("vh9g_a_ref_to_a_file_outside_the_project_and_the_agents_store_is_refused", async () => {
    const root = await project("p");
    const stray = join(base, "stray.jsonl");
    await writeFile(
      stray,
      `${JSON.stringify({ type: "user", cwd: root, timestamp: "2026-10-21T10:00:00.000Z", message: { role: "user", content: "x" } })}\n`,
    );
    const ref: SessionRef = {
      agent: "claude-code",
      session_id: "stray",
      project_root: root,
      path: stray,
    };
    await expect(collect(claudeCodeCollector({ configDir }).read(ref))).rejects.toMatchObject({
      code: "HISTORY_PATH_OUTSIDE_PROJECT",
    });
  });

  test("vh9g_a_symlinked_log_that_leads_out_of_the_store_is_refused", async () => {
    const root = await project("p");
    const secret = join(base, "secret.jsonl");
    await writeFile(
      secret,
      `${JSON.stringify({ type: "user", cwd: root, timestamp: "2026-10-21T10:00:00.000Z", message: { role: "user", content: "x" } })}\n`,
    );
    const folder = join(configDir, "projects", claudeFolderName(root));
    await mkdir(folder, { recursive: true });
    const link = join(folder, "linked.jsonl");
    await symlink(secret, link);
    const collector = claudeCodeCollector({ configDir });
    const ref: SessionRef = {
      agent: "claude-code",
      session_id: "linked",
      project_root: root,
      path: link,
      cwd: root,
    };
    await expect(collect(collector.read(ref))).rejects.toBeInstanceOf(KodelError);
    expect((await collector.locate(root)).map((r) => r.session_id)).toEqual(["linked"]);
  });

  test("vh9g_a_session_of_another_project_in_the_store_is_refused_by_its_cwd", async () => {
    const mine = await project("mine");
    const other = await project("other");
    const log = await installClaudeSession({ configDir, cwd: other, subagents: false });
    const ref: SessionRef = {
      agent: "claude-code",
      session_id: CLAUDE_FIXTURE_SESSION,
      project_root: mine,
      path: log,
    };
    await expect(collect(claudeCodeCollector({ configDir }).read(ref))).rejects.toMatchObject({
      code: "HISTORY_PATH_OUTSIDE_PROJECT",
    });
  });

  test("vh9g_a_forged_index_line_cannot_bring_in_a_log_of_another_project", async () => {
    const mine = await project("mine");
    const other = await project("other");
    const foreign = await installClaudeSession({ configDir, cwd: other, subagents: false });
    const line = {
      session_id: CLAUDE_FIXTURE_SESSION,
      agent: "claude-code",
      transcript_path: foreign,
      cwd: mine,
      ts: "2026-10-21T10:00:00.000Z",
    };
    await writeFile(join(mine, SESSIONS_INDEX), `${JSON.stringify(line)}\n`);
    const collector = claudeCodeCollector({ configDir });
    const [ref] = await collector.locate(mine);
    expect(ref?.cwd).toBeUndefined();
    await expect(collect(collector.read(ref as SessionRef))).rejects.toMatchObject({
      code: "HISTORY_PATH_OUTSIDE_PROJECT",
    });
  });

  test("vh9g_a_jsonl_file_inside_the_project_is_not_a_session_log", async () => {
    const root = await project("p");
    const inside = join(root, "notes.jsonl");
    await writeFile(
      inside,
      `${JSON.stringify({ type: "user", cwd: root, timestamp: "2026-10-21T10:00:00.000Z", message: { role: "user", content: "x" } })}\n`,
    );
    const ref: SessionRef = {
      agent: "claude-code",
      session_id: "notes",
      project_root: root,
      path: inside,
      cwd: root,
    };
    await expect(collect(claudeCodeCollector({ configDir }).read(ref))).rejects.toMatchObject({
      code: "HISTORY_PATH_OUTSIDE_PROJECT",
    });
  });

  test("vh9g_a_secret_across_the_cut_of_a_tool_output_does_not_reach_an_event", async () => {
    const root = await project("p");
    const log = await installClaudeSession({ configDir, cwd: root, subagents: false });
    const key = "AKIAIOSFODNN7EXAMPLE";
    const output = `${"a".repeat(498 - 12)} ${key} tail`;
    const entry = {
      type: "user",
      cwd: root,
      version: "2.1.306",
      timestamp: "2026-10-21T10:03:00.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_k", content: output }],
      },
    };
    await appendFile(log, `${JSON.stringify(entry)}\n`);
    const collector = claudeCodeCollector({ configDir });
    const [ref] = await collector.locate(root);
    const text = JSON.stringify(await collect(collector.read(ref as SessionRef)));
    expect(text).not.toContain("AKIAIOSF");
  });

  test("vh9g_time_does_not_go_back_even_when_the_log_says_so", async () => {
    const root = await project("p");
    const log = await installClaudeSession({ configDir, cwd: root, subagents: false });
    const early = {
      type: "user",
      cwd: root,
      version: "2.1.306",
      timestamp: "2026-10-21T09:00:00.000Z",
      message: { role: "user", content: "earlier than the line above" },
    };
    await appendFile(log, `${JSON.stringify(early)}\n`);
    const collector = claudeCodeCollector({ configDir });
    const [ref] = await collector.locate(root);
    const events = await collect(collector.read(ref as SessionRef));
    for (let i = 1; i < events.length; i += 1)
      expect((events[i]?.ts ?? "") >= (events[i - 1]?.ts ?? "")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      text_preview: "earlier than the line above",
      ts: "2026-10-21T10:00:08.100Z",
    });
  });

  test("vh9g_a_ref_of_another_agent_or_to_a_directory_is_unreadable", async () => {
    const root = await project("p");
    const collector = claudeCodeCollector({ configDir });
    const wrong: SessionRef = {
      agent: "codex",
      session_id: "x",
      project_root: root,
      path: join(root, "x"),
    };
    await expect(collect(collector.read(wrong))).rejects.toMatchObject({
      code: "HISTORY_SESSION_UNREADABLE",
    });
    const folder = join(configDir, "projects", claudeFolderName(root));
    await mkdir(folder, { recursive: true });
    const dir: SessionRef = {
      agent: "claude-code",
      session_id: "x",
      project_root: root,
      path: folder,
    };
    await expect(collect(collector.read(dir))).rejects.toMatchObject({
      code: "HISTORY_SESSION_UNREADABLE",
    });
  });

  test("vh9g_the_collector_never_names_a_credential_file_or_table", async () => {
    const dir = fileURLToPath(new URL("../src/history/", import.meta.url));
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const entry of await readdir(d, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(join(d, entry.name));
        else files.push(join(d, entry.name));
      }
    };
    await walk(dir);
    const forbidden = [
      ".credentials",
      "credentials.json",
      "auth.json",
      "settings.json",
      "settings.local.json",
      "api_key",
      "oauth",
      "keychain",
      "token_store",
    ];
    for (const file of files) {
      const text = (await readFile(file, "utf8")).toLowerCase();
      for (const name of forbidden) expect(`${file}:${text.includes(name)}`).toBe(`${file}:false`);
    }
  });

  test("vh9g_the_fixtures_stay_where_the_tests_expect_them", async () => {
    expect((await readdir(CLAUDE_FIXTURE)).sort()).toEqual(["session.jsonl", "subagents"]);
  });
});
