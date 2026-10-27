import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CaptureOptions,
  type HistoryEvent,
  historyEventSchema,
  type ReadCheckpoint,
  type ReadOptions,
  redactText,
  type SessionRef,
} from "@kodel-ai/pipeline-core";
import {
  CLAUDE_FIXTURE,
  CLAUDE_FIXTURE_SESSION,
  ClaudeLogBuilder,
  installClaudeSession,
} from "../../testkit/src";
import { claudeCodeCollector, findRunStart } from "../src/history";

const MARKER = join(".kodel", "config.yaml");
const GOLDEN = new URL("../../../fixtures/formats/v1/history/", import.meta.url).pathname;

let base: string;
let configDir: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "kodel-agent-log-")));
  configDir = join(base, "claude");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function project(name = "p"): Promise<string> {
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

const SESSION = "22222222-2222-4222-8222-222222222222";

/** A project with one session built by `build`, and the ref the collector gives for it. */
async function built(build: (log: ClaudeLogBuilder) => void) {
  const root = await project();
  const log = new ClaudeLogBuilder({ sessionId: SESSION, cwd: root });
  build(log);
  const path = await log.install(configDir);
  const collector = claudeCodeCollector({ configDir });
  const ref = (await collector.locate(root)).find((r) => r.session_id === SESSION) as SessionRef;
  expect(ref).toBeDefined();
  return { root, log, path, collector, ref };
}

const read = async (
  collector: ReturnType<typeof claudeCodeCollector>,
  ref: SessionRef,
  options?: ReadOptions,
) => collect(collector.read(ref, undefined, options));

const previewsOf = (events: HistoryEvent[]) =>
  events.flatMap((e) =>
    e.kind === "message"
      ? [e.text_preview]
      : e.kind === "tool_call"
        ? [e.input_preview]
        : e.kind === "tool_result"
          ? [e.output_preview]
          : [],
  );

/** A response, a tool call and its result, then another response that is left open. */
function conversation(log: ClaudeLogBuilder): void {
  log
    .user("hello")
    .say("msg_A", "first answer")
    .call("msg_A", { id: "toolu_1", name: "Bash", input: { command: "ls" } })
    .result("toolu_1", "file-a\nfile-b")
    .say("msg_B", "second answer");
}

describe("t3bk2 collector options: defaults stay as they were", () => {
  test("t3bk2_golden_unchanged_default_options", async () => {
    const root = await project();
    await installClaudeSession({ configDir, cwd: root });
    const collector = claudeCodeCollector({ configDir });
    const ref = (await collector.locate(root)).find(
      (r) => r.session_id === CLAUDE_FIXTURE_SESSION,
    ) as SessionRef;
    const text = (await read(collector, ref))
      .map((e) =>
        JSON.stringify(e)
          .replaceAll(root, "__CWD__")
          .replace('"cwd":"__CWD__"', '"cwd":"[REDACTED:high-entropy]"'),
      )
      .join("\n");
    expect(`${text}\n`).toBe(
      await readFile(join(GOLDEN, "claude-code-session.events.jsonl"), "utf8"),
    );
  });

  test("t3bk2_options_inert", async () => {
    const root = await project();
    await installClaudeSession({ configDir, cwd: root, subagents: false });
    const collector = claudeCodeCollector({ configDir });
    const ref = (await collector.locate(root))[0] as SessionRef;
    const plain = JSON.stringify(await read(collector, ref));
    expect(JSON.stringify(await read(collector, ref, { capture: {} }))).toBe(plain);
    expect(JSON.stringify(await read(collector, ref, { holdBack: false }))).toBe(plain);
    expect(JSON.stringify(await read(collector, ref, { capture: { caps: {} } }))).toBe(plain);
  });
});

describe("t3bk2 collector options: metadata mode", () => {
  const CANARIES = [
    "CANARY_USER",
    "CANARY_AGENT",
    "CANARY_INPUT",
    "CANARY_RESULT",
    "CANARY_SYSTEM",
    "CANARY_DESC",
    "CANARY_BRANCH",
  ];
  const ALLOW = [
    "v",
    "agent",
    "agent_version",
    "session_id",
    "parent_session_id",
    "seq",
    "ts",
    "kind",
    "role",
    "message_id",
    "model",
    "input",
    "output",
    "cache_read",
    "cache_write",
    "reasoning",
    "semantics",
    "request_id",
    "cost",
    "id",
    "name",
    "mcp_server",
    "started",
    "ok",
    "ended",
    "duration_ms",
    "size",
    "agent_id",
    "child_session_id",
    "subtype",
  ];
  const DENY = [
    "text_preview",
    "input_preview",
    "output_preview",
    "description_preview",
    "detail",
    "cwd",
    "git_branch",
  ];

  function withCanaries(log: ClaudeLogBuilder): void {
    log
      .user("CANARY_USER text")
      .say("msg_A", "CANARY_AGENT text")
      .call("msg_A", { id: "toolu_1", name: "Bash", input: { command: "echo CANARY_INPUT" } })
      .result("toolu_1", "CANARY_RESULT output")
      .call("msg_B", {
        id: "toolu_2",
        name: "Agent",
        input: { description: "CANARY_DESC", prompt: "p" },
      })
      .subagentResult("toolu_2", "abc123", "CANARY_RESULT done")
      .system("note", "CANARY_SYSTEM text")
      .say("msg_C", "bye");
  }

  test("t3bk2_metadata_allowlist_no_text", async () => {
    // every field of every kind is classed, so a field added later fails here until someone decides about it
    const keys = new Set(historyEventSchema.options.flatMap((o) => Object.keys(o.shape)));
    expect([...keys].filter((k) => !ALLOW.includes(k) && !DENY.includes(k))).toEqual([]);
    expect(ALLOW.filter((k) => DENY.includes(k))).toEqual([]);

    const root = await project();
    const log = new ClaudeLogBuilder({ sessionId: SESSION, cwd: root, gitBranch: "CANARY_BRANCH" });
    withCanaries(log);
    await log.install(configDir);
    const collector = claudeCodeCollector({ configDir });
    const ref = (await collector.locate(root))[0] as SessionRef;
    const events = await read(collector, ref, { capture: { metadata: true } });
    const text = JSON.stringify(events);
    for (const canary of CANARIES) expect(text).not.toContain(canary);
    expect(text).not.toContain(root);
    for (const event of events) {
      for (const key of DENY) expect(key in event).toBe(false);
    }
    // what is kept is still there
    expect(
      events.filter((e) => e.kind === "tool_call").map((e) => e.kind === "tool_call" && e.name),
    ).toEqual(["Bash", "Agent"]);
    expect(events.find((e) => e.kind === "tool_result")).toMatchObject({ ok: true, size: 20 });
    expect(events.find((e) => e.kind === "usage")).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(events.find((e) => e.kind === "subagent")).toMatchObject({ agent_id: "abc123" });
  });

  test("t3bk2_metadata_events_validate", async () => {
    const { collector, ref } = await built(withCanaries);
    const events = await read(collector, ref, { capture: { metadata: true } });
    expect(events.length).toBeGreaterThan(5);
    for (const event of events) expect(historyEventSchema.safeParse(event).success).toBe(true);
    const messages = events.filter((e) => e.kind === "message");
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) expect("text_preview" in message).toBe(false);
  });

  test("t3bk2_old_event_still_parses", () => {
    const old = {
      v: 1,
      agent: "claude-code",
      agent_version: "2.1.306",
      session_id: "s",
      seq: 1,
      ts: "2026-10-21T10:00:00.000Z",
      kind: "message",
      role: "user",
      text_preview: "hello",
    };
    expect(historyEventSchema.safeParse(old).success).toBe(true);
    const { text_preview: _dropped, ...without } = old;
    expect(historyEventSchema.safeParse(without).success).toBe(true);
  });
});

describe("t3bk2 collector options: caps", () => {
  test("t3bk2_caps_per_kind", async () => {
    const long = "word ".repeat(100);
    const { collector, ref } = await built((log) =>
      log
        .user(long)
        .say("msg_A", long)
        .call("msg_A", { id: "toolu_1", name: "Bash", input: { command: long } })
        .result("toolu_1", long)
        .say("msg_B", "end"),
    );
    const events = await read(collector, ref, {
      capture: { caps: { user: 10, agent: 20, tool_input: 30, tool_result: 40 } },
    });
    const length = (kind: string, role?: string) =>
      (
        events.find((e) =>
          e.kind === "message" ? e.kind === kind && e.role === role : e.kind === kind,
        ) as { text_preview?: string; input_preview?: string; output_preview?: string }
      )?.text_preview?.length ??
      (events.find((e) => e.kind === kind) as { input_preview?: string; output_preview?: string })
        ?.input_preview?.length ??
      (events.find((e) => e.kind === kind) as { output_preview?: string })?.output_preview?.length;
    expect(length("message", "user")).toBe(10);
    expect(length("message", "assistant")).toBe(20);
    expect(length("tool_call")).toBe(30);
    expect(length("tool_result")).toBe(40);
  });

  test("t3bk2_caps_zero", async () => {
    const { collector, ref } = await built(conversation);
    const events = await read(collector, ref, {
      capture: { caps: { user: 0, agent: 0, tool_input: 0, tool_result: 0 } },
    });
    expect(previewsOf(events).filter((p) => p !== undefined)).toEqual([]);
    for (const event of events) expect(historyEventSchema.safeParse(event).success).toBe(true);
  });

  test("t3bk2_caps_boundary", async () => {
    const cap = 10;
    const { collector, ref } = await built((log) =>
      log
        .user("a".repeat(cap - 1))
        .user("b".repeat(cap))
        .user("c".repeat(cap + 1)),
    );
    const events = await read(collector, ref, { capture: { caps: { user: cap } } });
    const shown = previewsOf(events);
    expect(shown).toEqual(["a".repeat(cap - 1), "b".repeat(cap), `${"c".repeat(cap - 1)}…`]);
    expect(shown.map((s) => s?.length)).toEqual([9, 10, 10]);
  });

  test("t3bk2_caps_surrogate_and_cjk", async () => {
    const { collector, ref } = await built((log) => log.user("aaaa😀😀😀").user("日本語日本語日"));
    const events = await read(collector, ref, { capture: { caps: { user: 6 } } });
    const [emoji, cjk] = previewsOf(events) as string[];
    // the cut falls between the halves of a pair: the pair goes, no half of it stays
    expect(emoji).toBe("aaaa…");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji as string)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji as string)).toBe(false);
    expect(cjk).toBe("日本語日本…");
  });

  test("t3bk2_caps_invalid", async () => {
    const text = "x".repeat(600);
    const { collector, ref } = await built((log) => log.user(text));
    for (const bad of [Number.NaN, -1, 2.5, Number.POSITIVE_INFINITY]) {
      const events = await read(collector, ref, { capture: { caps: { user: bad } } });
      // a cap the collector cannot use is the default one, never a text of nothing or of everything
      expect(previewsOf(events)[0]?.length).toBe(500);
    }
  });

  test("t3bk2_caps_keep_line_breaks", async () => {
    const { collector, ref } = await built((log) => log.user("a  b\n\n\n\nc\r\nd\t e"));
    const flat = await read(collector, ref);
    const kept = await read(collector, ref, { capture: { keepLineBreaks: true } });
    expect(previewsOf(flat)).toEqual(["a b c d e"]);
    expect(previewsOf(kept)).toEqual(["a b\n\nc\nd e"]);
  });
});

describe("t3bk2 collector options: redaction", () => {
  const KEY = "AKIAIOSFODNN7EXAMPLE";
  const TOKEN = `ghp_${"A1b2C3d4E5".repeat(4)}`;

  test("t3bk2_redact_tool_input", async () => {
    const { collector, ref } = await built((log) =>
      log
        .say("msg_A", "x")
        .call("msg_A", { id: "toolu_1", name: "Bash", input: { command: `export K=${KEY}` } })
        .say("msg_B", "y"),
    );
    expect(JSON.stringify(await read(collector, ref))).not.toContain(KEY);
  });

  test("t3bk2_redact_tool_result", async () => {
    const { collector, ref } = await built((log) =>
      log.result("toolu_1", `found ${TOKEN} in the file`),
    );
    const text = JSON.stringify(await read(collector, ref));
    expect(text).not.toContain(TOKEN.slice(0, 12));
    expect(text).toContain("[REDACTED:");
  });

  test("t3bk2_redact_user_and_agent_text", async () => {
    const { collector, ref } = await built((log) =>
      log.user(`use ${KEY}`).say("msg_A", `the key is ${TOKEN}`).say("msg_B", "next"),
    );
    const text = JSON.stringify(await read(collector, ref));
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(TOKEN.slice(0, 12));
  });

  test("t3bk2_redact_across_cut", async () => {
    // the cap falls inside the token: the token is replaced first and the cut then falls in the tag
    const content = `${"a".repeat(30)} ${TOKEN} tail`;
    const { collector, ref } = await built((log) => log.result("toolu_1", content));
    const events = await read(collector, ref, { capture: { caps: { tool_result: 50 } } });
    const shown = previewsOf(events)[0] as string;
    for (let i = 0; i + 8 <= TOKEN.length; i++) expect(shown).not.toContain(TOKEN.slice(i, i + 8));
  });

  test("t3bk2_redact_project_rule", async () => {
    const { collector, ref } = await built((log) => log.user("the code is PROJSECRET-12345 ok"));
    const capture: CaptureOptions = { rules: [{ name: "proj", pattern: /PROJSECRET-\d+/g }] };
    const text = JSON.stringify(await read(collector, ref, { capture }));
    expect(text).not.toContain("PROJSECRET");
    expect(text).toContain("[REDACTED:proj]");
    // without the rule it is plain text
    expect(JSON.stringify(await read(collector, ref))).toContain("PROJSECRET-12345");
  });

  test("t3bk2_redact_unknown_pattern_stays", async () => {
    // the documented gap (docs/history.md, residual risk): a hex-only token matches no rule and stays
    const hex = "deadbeef".repeat(5);
    const { collector, ref } = await built((log) => log.user(`token ${hex}`));
    expect(JSON.stringify(await read(collector, ref))).toContain(hex);
  });

  test("t3bk2_ids_skip_option_leaves_ids_to_the_consumer", async () => {
    const id = "toolu_01Qh5Zr8KdLm3NpTxV9aBcWy2EfGjR7sUo";
    expect(redactText(id)).not.toBe(id); // the premise: the entropy rule would rewrite it
    const { collector, ref } = await built((log) =>
      log
        .say("msg_A", "x")
        .call("msg_A", { id, name: "Bash", input: { command: "ls" } })
        .result(id, "out")
        .say("msg_B", "y"),
    );
    const ids = (events: HistoryEvent[]) =>
      events.flatMap((e) => (e.kind === "tool_call" || e.kind === "tool_result" ? [e.id] : []));
    expect(ids(await read(collector, ref))).toEqual([
      "[REDACTED:high-entropy]",
      "[REDACTED:high-entropy]",
    ]);
    expect(ids(await read(collector, ref, { capture: { skipIds: true } }))).toEqual([id, id]);
  });
});

describe("t3bk2 collector options: whole responses", () => {
  test("t3bk2_open_response_held_back", async () => {
    const { collector, ref } = await built(conversation);
    const full = await read(collector, ref);
    const held = await read(collector, ref, { holdBack: true });
    // what is held is the last response: its text and its usage; the rest is a prefix of the full read
    expect(held).toEqual(full.slice(0, held.length));
    expect(full.length - held.length).toBe(2);
    expect(full.slice(held.length).map((e) => e.kind)).toEqual(["message", "usage"]);
    expect(held.at(-1)).toMatchObject({ kind: "tool_result", id: "toolu_1" });
    expect(held.filter((e) => e.kind === "usage")).toHaveLength(1);
  });

  test("t3bk2_holdback_with_nothing_open_is_the_full_read", async () => {
    const { collector, ref } = await built((log) => log.user("hello").system("note", "n"));
    expect(await read(collector, ref, { holdBack: true })).toEqual(await read(collector, ref));
  });
});

async function checkpointOf(
  collector: ReturnType<typeof claudeCodeCollector>,
  ref: SessionRef,
  options: ReadOptions = {},
): Promise<{ events: HistoryEvent[]; checkpoint: ReadCheckpoint }> {
  const holder: { value?: ReadCheckpoint } = {};
  const events = await read(collector, ref, { ...options, holdBack: true, checkpoint: holder });
  expect(holder.value, `no checkpoint after ${events.length} events`).toBeDefined();
  return { events, checkpoint: holder.value as ReadCheckpoint };
}

describe("t3bk2 collector options: resuming a read", () => {
  /** Reads `lines` in two parts, cut at every line boundary, and compares with one read of the whole. */
  async function everyBoundary(lines: string[], ref: SessionRef, path: string, from = 1) {
    const collector = claudeCodeCollector({ configDir });
    await writeFile(path, lines.map((l) => `${l}\n`).join(""));
    const whole = await read(collector, ref, { holdBack: true });
    for (let k = from; k < lines.length; k++) {
      await writeFile(
        path,
        lines
          .slice(0, k)
          .map((l) => `${l}\n`)
          .join(""),
      );
      const first = await checkpointOf(collector, ref);
      await appendFile(
        path,
        lines
          .slice(k)
          .map((l) => `${l}\n`)
          .join(""),
      );
      const second = await checkpointOf(collector, ref, { resume: first.checkpoint });
      expect([...first.events, ...second.events]).toEqual(whole);
    }
  }

  test("t3bk2_resume_equals_full_read", async () => {
    const { log, ref, path } = await built((l) =>
      l
        .user("start")
        .say("msg_A", "a")
        .call("msg_A", { id: "toolu_1", name: "Bash", input: { command: "ls" } })
        .result("toolu_1", "out")
        .say("msg_B", "b")
        .call("msg_B", { id: "toolu_2", name: "Agent", input: { description: "d" } })
        .subagentResult("toolu_2", "abc123")
        .system("note", "n")
        .say("msg_C", "c"),
    );
    await everyBoundary(log.lines, ref, path);
  });

  test("t3bk2_resume_equals_full_read_with_repeats", async () => {
    const { log, ref, path } = await built((l) =>
      l
        .user("start")
        .say("msg_A", "a")
        .call("msg_A", { id: "toolu_1", name: "Bash", input: { command: "ls" } })
        .say("msg_B", "b")
        .result("toolu_1", "late result")
        .say("msg_A", "a again, after a compaction") // a response that was closed comes back
        .result("toolu_1", "the same result twice")
        .say("msg_C", "c"),
    );
    // a line written twice is read once
    const lines = [...log.lines.slice(0, 3), log.lines[2] as string, ...log.lines.slice(3)];
    await everyBoundary(lines, ref, path);
  });

  test("t3bk2_resume_equals_full_read_on_the_fixture_session", async () => {
    const root = await project("fixture");
    const log = await installClaudeSession({ configDir, cwd: root, subagents: false });
    const collector = claudeCodeCollector({ configDir });
    const ref = (await collector.locate(root))[0] as SessionRef;
    const lines = (await readFile(log, "utf8")).split("\n").filter((l) => l !== "");
    expect(lines.length).toBeGreaterThan(10);
    // the first line of a real log has no `cwd`, and a log without one does not belong to a project
    await everyBoundary(lines, ref, log, 2);
    expect(CLAUDE_FIXTURE).toContain("claude-code");
  });

  test("t3bk2_resume_torn_line", async () => {
    const { log, ref, path, collector } = await built((l) => l.user("one").say("msg_A", "two"));
    const next = new ClaudeLogBuilder({
      sessionId: SESSION,
      cwd: base,
      start: "2026-10-21T11:00:00.000Z",
    });
    next.say("msg_B", "three");
    const line = next.lines[0] as string;
    const half = line.slice(0, 40);
    await appendFile(path, half);
    const first = await checkpointOf(collector, ref);
    // the torn line is not consumed: a later read starts at it
    expect(first.checkpoint.offset).toBe(Buffer.byteLength(log.text()));
    await appendFile(path, `${line.slice(40)}\n`);
    const second = await checkpointOf(collector, ref, { resume: first.checkpoint });
    const whole = await read(collector, ref, { holdBack: true });
    expect([...first.events, ...second.events]).toEqual(whole);
  });

  test("t3bk2_resume_state_bounded", async () => {
    const calls = 10_500;
    const { collector, ref, path } = await built((l) => {
      l.user("start").say("msg_A", "a");
      for (let i = 0; i < calls; i++)
        l.call("msg_A", { id: `toolu_${i}`, name: "Bash", input: { n: i } });
    });
    expect(path).toContain(SESSION);
    const { checkpoint } = await checkpointOf(collector, ref);
    const state = checkpoint.state as {
      claude: { calls: Map<string, unknown>; seen: Set<string> };
    };
    // calls that never got a result do not pile up
    expect(state.claude.calls.size).toBeLessThanOrEqual(10_000);
    expect(state.claude.seen.size).toBeLessThanOrEqual(1_000_000);
  });

  test("t3bk2_should_stop_ends_the_read_between_entries", async () => {
    const { collector, ref } = await built(conversation);
    let asked = 0;
    const first = await checkpointOf(collector, ref, { shouldStop: () => ++asked > 3 });
    const rest = await checkpointOf(collector, ref, { resume: first.checkpoint });
    const whole = await read(collector, ref, { holdBack: true });
    expect([...first.events, ...rest.events]).toEqual(whole);
    expect(first.events.length).toBeLessThan(whole.length);
  });
});

describe("t3bk2 collector options: where a run begins in a log", () => {
  const RID = "r_0abcdefgh_wxyz";
  const OTHER = "r_0zzzzzzzz_aaaa";
  const start = (
    log: ClaudeLogBuilder,
    msg: string,
    id: string,
    runId: string,
    name = "mcp__kodel__pipeline_start",
  ) =>
    log
      .call(msg, { id, name, input: { task: "do it" } })
      .result(id, [{ type: "text", text: JSON.stringify({ ok: true, run_id: runId }) }]);

  test("t3bk2_proof_first_call_with_run_id", async () => {
    const { log, path } = await built((l) => {
      l.user("please run the pipeline").say("msg_A", "ok, starting");
      start(l, "msg_A", "toolu_1", RID);
      l.call("msg_B", {
        id: "toolu_2",
        name: "mcp__kodel__pipeline_next_step",
        input: { run_id: RID },
      });
    });
    // the start has no run id in its input; its result names the run, and the window starts at the call
    expect(await findRunStart(path, RID)).toEqual({ offset: log.offsetOf(2) });
  });

  test("t3bk2_proof_resumed_session_captured", async () => {
    // a session that never started the run, but works on it: the id is in the input of its first call
    const { log, path } = await built((l) => {
      l.user("continue the run").call("msg_A", {
        id: "toolu_1",
        name: "mcp__kodel__pipeline_next_step",
        input: { run_id: RID },
      });
    });
    expect(await findRunStart(path, RID)).toEqual({ offset: log.offsetOf(1) });
  });

  test("t3bk2_proof_other_run_id_is_unknown", async () => {
    const { path } = await built((l) => {
      start(l, "msg_A", "toolu_1", OTHER);
      l.call("msg_B", {
        id: "toolu_2",
        name: "mcp__kodel__pipeline_next_step",
        input: { run_id: OTHER },
      });
    });
    expect(await findRunStart(path, RID)).toBeUndefined();
  });

  test("t3bk2_proof_a_mention_is_not_a_call", async () => {
    // the person or the agent writing the id in a message, or a tool that is not the pipeline's, proves nothing
    const { path } = await built((l) => {
      l.user(`what happened to ${RID}?`)
        .say("msg_A", `I will look at ${RID}`)
        .call("msg_A", { id: "toolu_1", name: "Bash", input: { command: `cat ${RID}` } })
        .result("toolu_1", RID);
    });
    expect(await findRunStart(path, RID)).toBeUndefined();
  });

  test("t3bk2_proof_two_runs_one_session", async () => {
    const { log, path } = await built((l) => {
      start(l, "msg_A", "toolu_1", RID);
      l.call("msg_B", {
        id: "toolu_2",
        name: "mcp__kodel__pipeline_complete_step",
        input: { run_id: RID },
      });
      start(l, "msg_C", "toolu_3", OTHER);
    });
    expect(await findRunStart(path, RID)).toEqual({ offset: log.offsetOf(0) });
    expect(await findRunStart(path, OTHER)).toEqual({ offset: log.offsetOf(3) });
  });

  test("t3bk2_proof_same_response_ends_and_starts", async () => {
    // one response ends run A and starts run B: B begins at its own call, not at the start of the response
    const { log, path } = await built((l) => {
      l.call("msg_A", {
        id: "toolu_1",
        name: "mcp__kodel__pipeline_complete_step",
        input: { run_id: OTHER },
      });
      l.say("msg_A", "and now the next one");
      start(l, "msg_A", "toolu_2", RID);
    });
    expect(await findRunStart(path, RID)).toEqual({ offset: log.offsetOf(2) });
  });

  test("t3bk2_proof_failed_start_call", async () => {
    const { log, path } = await built((l) => {
      l.call("msg_A", {
        id: "toolu_1",
        name: "mcp__kodel__pipeline_start",
        input: { task: "x" },
      }).result("toolu_1", "error: the project has no pipeline", true);
      start(l, "msg_B", "toolu_2", RID);
    });
    expect(await findRunStart(path, RID)).toEqual({ offset: log.offsetOf(2) });
  });

  test("t3bk2_proof_any_server_name", async () => {
    const { log, path } = await built((l) =>
      start(l, "msg_A", "toolu_1", RID, "mcp__pipelines__pipeline_start"),
    );
    expect(await findRunStart(path, RID)).toEqual({ offset: log.offsetOf(0) });
  });

  test("t3bk2_proof_metadata_mode_still_matches", async () => {
    const { log, path, collector, ref } = await built((l) => {
      l.user("CANARY_USER before the run").say("msg_A", "CANARY_AGENT before the run");
      start(l, "msg_B", "toolu_1", RID);
      l.say("msg_C", "CANARY_AFTER");
    });
    const found = await findRunStart(path, RID);
    expect(found).toEqual({ offset: log.offsetOf(2) });
    const events = await read(collector, ref, {
      fromOffset: (found as { offset: number }).offset,
      capture: { metadata: true },
    });
    const text = JSON.stringify(events);
    // the window holds the call and what follows, and nothing before it, and no text in metadata mode
    expect(events.find((e) => e.kind === "tool_call")).toMatchObject({ id: "toolu_1" });
    expect(text).not.toContain("CANARY");
    expect(
      events.filter((e) => e.kind === "message").map((e) => e.kind === "message" && e.message_id),
    ).toEqual(["msg_C"]);
  });

  test("t3bk2_proof_text_before_call_outside", async () => {
    const { log, collector, ref } = await built((l) => {
      l.say("msg_A", "BEFORE the call, same response");
      start(l, "msg_A", "toolu_1", RID);
      l.say("msg_A", "AFTER the call");
    });
    const events = await read(collector, ref, { fromOffset: log.offsetOf(1) });
    const texts = events.flatMap((e) => (e.kind === "message" ? [e.text_preview] : []));
    expect(texts).toEqual(["AFTER the call"]);
    expect(events[0]?.seq).toBe(1);
  });
});
