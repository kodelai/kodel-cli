import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHookLog,
  defaultHookRegistry,
  findProjectRoot,
  HOOK_LOG,
  HOOK_LOG_MAX_BYTES,
  hookCommand,
  isKodelHookCommand,
  MAX_PAYLOAD_BYTES,
  opencodePluginSource,
  readCapped,
  readRegisteredEvents,
  runHook,
  SESSIONS_INDEX,
} from "../src/hooks";

let base: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "kodel-hook-")));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A Kodel project: the committed config is its marker. */
async function project(...parts: string[]): Promise<string> {
  const root = join(base, ...parts);
  await mkdir(join(root, ".kodel"), { recursive: true });
  await writeFile(join(root, ".kodel", "config.yaml"), "version: 1\n");
  return root;
}

const start = (cwd: string, over: Record<string, unknown> = {}) => ({
  text: JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: "s-1",
    transcript_path: "/t/s-1.jsonl",
    cwd,
    ...over,
  }),
  tooLarge: false,
});

const lines = async (root: string, file = SESSIONS_INDEX) =>
  (await readFile(join(root, file), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const NOW = new Date("2026-10-24T12:00:00.000Z");

describe("findProjectRoot", () => {
  test("the_nearest_directory_with_the_marker_upward_is_the_root", async () => {
    const root = await project("a");
    await mkdir(join(root, "src", "deep"), { recursive: true });
    expect(await findProjectRoot(join(root, "src", "deep"))).toBe(root);
    expect(await findProjectRoot(root)).toBe(root);
  });

  test("no_marker_upward_is_no_project", async () => {
    await mkdir(join(base, "plain", "dir"), { recursive: true });
    expect(await findProjectRoot(join(base, "plain", "dir"))).toBeUndefined();
  });

  test("a_directory_named_like_the_marker_is_not_one", async () => {
    await mkdir(join(base, "x", ".kodel", "config.yaml"), { recursive: true });
    expect(await findProjectRoot(join(base, "x"))).toBeUndefined();
  });

  test("a_run_worktree_belongs_to_the_project_that_holds_it", async () => {
    const root = await project("p");
    const worktree = await project("p", ".kodel", "worktrees", "r_1");
    await mkdir(join(worktree, "src"), { recursive: true });
    expect(await findProjectRoot(worktree)).toBe(root);
    expect(await findProjectRoot(join(worktree, "src"))).toBe(root);
  });

  test("a_nested_project_that_is_not_a_worktree_keeps_its_own_root", async () => {
    await project("outer");
    const inner = await project("outer", "packages", "inner");
    expect(await findProjectRoot(inner)).toBe(inner);
  });
});

describe("the session registrar", () => {
  test("a_session_start_in_a_project_adds_one_line_to_the_index", async () => {
    const root = await project("p");
    const out = await runHook("claude-code", start(root), { now: NOW });
    expect(out).toBe("");
    expect(await lines(root)).toEqual([
      {
        session_id: "s-1",
        agent: "claude-code",
        transcript_path: "/t/s-1.jsonl",
        cwd: root,
        ts: NOW.toISOString(),
      },
    ]);
  });

  test("a_subdirectory_and_a_run_worktree_write_to_the_project_index", async () => {
    const root = await project("p");
    const sub = join(root, "src");
    await mkdir(sub);
    const worktree = await project("p", ".kodel", "worktrees", "r_1");
    await runHook("codex", start(sub, { session_id: "a" }), { now: NOW });
    await runHook("codex", start(worktree, { session_id: "b" }), { now: NOW });
    expect((await lines(root)).map((l) => [l.session_id, l.cwd])).toEqual([
      ["a", sub],
      ["b", worktree],
    ]);
    expect(await lines(worktree)).toEqual([]);
  });

  test("two_projects_side_by_side_get_only_their_own_sessions", async () => {
    const one = await project("one");
    const two = await project("two");
    await runHook("claude-code", start(one, { session_id: "1" }), { now: NOW });
    await runHook("claude-code", start(two, { session_id: "2" }), { now: NOW });
    expect((await lines(one)).map((l) => l.session_id)).toEqual(["1"]);
    expect((await lines(two)).map((l) => l.session_id)).toEqual(["2"]);
  });

  test("the_same_session_twice_and_a_resumed_session_are_both_recorded", async () => {
    const root = await project("p");
    await runHook("claude-code", start(root), { now: NOW });
    await runHook("claude-code", start(root, { source: "resume" }), { now: NOW });
    expect(await lines(root)).toHaveLength(2);
  });

  test("an_event_no_handler_asked_for_writes_nothing", async () => {
    const root = await project("p");
    await runHook("claude-code", start(root, { hook_event_name: "PreToolUse" }), { now: NOW });
    expect(await lines(root)).toEqual([]);
    expect(await readdir(join(root, ".kodel"))).toEqual(["config.yaml"]);
  });

  test("a_record_without_a_transcript_has_no_transcript_field", async () => {
    const root = await project("p");
    await runHook("opencode", start(root, { transcript_path: undefined }), { now: NOW });
    expect((await lines(root))[0]).not.toHaveProperty("transcript_path");
  });
});

describe("outside a project", () => {
  test("nothing_is_written_anywhere_and_the_answer_is_empty", async () => {
    const plain = join(base, "plain");
    await mkdir(plain);
    expect(await runHook("claude-code", start(plain), { now: NOW })).toBe("");
    expect(await readdir(plain)).toEqual([]);
    expect(await readdir(base)).toEqual(["plain"]);
  });
});

describe("hardening", () => {
  test("input_that_is_not_an_event_does_nothing_and_does_not_throw", async () => {
    const root = await project("p");
    const inputs = [
      "",
      "not json",
      "{",
      "null",
      "[]",
      '{"hook_event_name":"SessionStart"}',
      Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x01]).toString("utf8"),
      `\u001b[2J${JSON.stringify({ hook_event_name: "SessionStart", session_id: "x", cwd: root })}`,
    ];
    for (const text of inputs) {
      expect(await runHook("claude-code", { text, tooLarge: false }, { now: NOW })).toBe("");
    }
    expect(await runHook("claude-code", { ...start(root), tooLarge: true }, { now: NOW })).toBe("");
    expect(await runHook("emacs", start(root), { now: NOW })).toBe("");
    expect(await runHook("", start(root), { now: NOW })).toBe("");
    expect(await lines(root)).toEqual([]);
  });

  test("terminal_escapes_in_a_payload_never_reach_the_index", async () => {
    const root = await project("p");
    await runHook(
      "claude-code",
      start(root, { session_id: "s\u001b[31m", transcript_path: "/t\u001b" }),
      {
        now: NOW,
      },
    );
    await runHook("claude-code", start(root, { transcript_path: "/t\u001b]0;x\u0007" }), {
      now: NOW,
    });
    const written = await readFile(join(root, SESSIONS_INDEX), "utf8");
    expect(written).not.toContain("\u001b");
    expect((await lines(root)).map((l) => l.session_id)).toEqual(["s-1"]);
  });

  test("a_hundred_megabytes_are_read_in_bounded_memory_and_dropped", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    async function* hundred() {
      for (let i = 0; i < 100; i += 1) yield chunk;
    }
    const before = process.memoryUsage().rss;
    const input = await readCapped(hundred());
    expect(input.tooLarge).toBe(true);
    expect(input.text).toBe("");
    expect(process.memoryUsage().rss - before).toBeLessThan(64 * 1024 * 1024);
    expect(await runHook("claude-code", input, { now: NOW })).toBe("");
  });

  test("a_payload_up_to_the_cap_is_kept_and_binary_data_survives_as_text", async () => {
    async function* chunks() {
      yield Buffer.from('{"a":"');
      yield Buffer.from([0xff, 0xfe]);
      yield Buffer.from('"}');
    }
    const input = await readCapped(chunks());
    expect(input.tooLarge).toBe(false);
    expect(input.text.startsWith('{"a":"')).toBe(true);
    expect(MAX_PAYLOAD_BYTES).toBeGreaterThan(1024 * 1024);
  });

  test("a_broken_stream_ends_the_input_without_throwing", async () => {
    async function* broken() {
      yield Buffer.from("{");
      throw new Error("EPIPE");
    }
    const input = await readCapped(broken());
    expect(input.tooLarge).toBe(false);
  });

  test("a_handler_that_cannot_write_is_logged_and_the_answer_is_still_empty", async () => {
    const root = await project("p");
    // A directory where the index should be: the append fails the same way on every platform.
    await mkdir(join(root, SESSIONS_INDEX));
    expect(await runHook("claude-code", start(root), { now: NOW })).toBe("");
    const log = await readFile(join(root, HOOK_LOG), "utf8");
    expect(log).toContain("claude-code SessionStart: session-registrar:");
    expect(log).toContain(NOW.toISOString());
  });

  test("a_handler_that_hangs_is_cut_off_and_logged", async () => {
    const root = await project("p");
    const registry = defaultHookRegistry();
    registry.register({ id: "hang", events: ["SessionStart"], run: () => new Promise(() => {}) });
    const started = Date.now();
    expect(await runHook("claude-code", start(root), { now: NOW, registry, timeoutMs: 40 })).toBe(
      "",
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await readFile(join(root, HOOK_LOG), "utf8")).toContain("hang: timed out after 40 ms");
    // The others ran.
    expect(await lines(root)).toHaveLength(1);
  });

  test("the_default_registry_prints_nothing", async () => {
    const root = await project("p");
    const registry = defaultHookRegistry();
    for (const handler of registry.all()) expect(handler.prints).not.toBe(true);
    expect(await runHook("codex", start(root), { now: NOW })).toBe("");
  });
});

describe("the hook log", () => {
  test("controls_in_a_message_are_replaced_and_a_long_message_is_cut", async () => {
    const root = await project("p");
    await appendHookLog(root, `bad \u001b[31m${"x".repeat(2000)}\nnext`, NOW);
    const text = await readFile(join(root, HOOK_LOG), "utf8");
    expect(text).not.toContain("\u001b");
    expect(text.split("\n").filter(Boolean)).toHaveLength(1);
    expect(text.length).toBeLessThan(600);
  });

  test("the_log_stays_below_its_cap", async () => {
    const root = await project("p");
    for (let i = 0; i < 400; i += 1) await appendHookLog(root, "y".repeat(400), NOW);
    const size = (await readFile(join(root, HOOK_LOG))).length;
    expect(size).toBeLessThan(HOOK_LOG_MAX_BYTES + 1000);
    expect(await readFile(join(root, HOOK_LOG), "utf8")).toContain("older lines dropped");
  });

  test("a_log_that_cannot_be_written_is_not_an_error", async () => {
    const root = await project("p");
    await mkdir(join(root, HOOK_LOG));
    await appendHookLog(root, "nowhere to go", NOW);
  });
});

describe("registration", () => {
  test("the_installed_kodel_gets_the_small_hook_bin_and_any_other_server_command_hook_for_mcp", () => {
    expect(hookCommand("kodel mcp", "claude-code")).toBe("kodel-hook claude-code");
    expect(hookCommand("  kodel  ", "opencode")).toBe("kodel-hook opencode");
    expect(hookCommand("bun packages/cli/src/main.ts mcp", "codex")).toBe(
      "bun packages/cli/src/main.ts hook codex",
    );
    expect(hookCommand("npx kodel@1 mcp", "codex")).toBe("npx kodel@1 hook codex");
  });

  test("a_kodel_hook_is_told_by_the_end_of_its_command", () => {
    expect(isKodelHookCommand("kodel-hook codex", "codex")).toBe(true);
    expect(isKodelHookCommand("/usr/local/bin/kodel-hook codex", "codex")).toBe(true);
    expect(isKodelHookCommand('"C:\\npm\\kodel-hook.cmd" codex', "codex")).toBe(true);
    expect(isKodelHookCommand("my-kodel-hook codex", "codex")).toBe(false);
    expect(isKodelHookCommand("kodel-hook claude-code", "codex")).toBe(false);
    expect(isKodelHookCommand("kodel hook codex", "codex")).toBe(true);
    expect(isKodelHookCommand('"C:\\Program Files\\kodel.cmd" hook codex', "codex")).toBe(true);
    expect(isKodelHookCommand("kodel hook codex", "claude-code")).toBe(false);
    expect(isKodelHookCommand("echo hook codex now", "codex")).toBe(false);
    expect(isKodelHookCommand(7, "codex")).toBe(false);
  });

  test("registered_events_are_read_back_from_each_agents_file", async () => {
    const root = await project("p");
    const entry = (command: string) => ({ hooks: [{ type: "command", command }] });
    await mkdir(join(root, ".claude"));
    await writeFile(
      join(root, ".claude", "settings.local.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [entry("echo mine"), entry("kodel hook claude-code")],
          Stop: [entry("echo mine")],
        },
      }),
    );
    expect(await readRegisteredEvents("claude-code", root)).toEqual(["SessionStart"]);
    expect(await readRegisteredEvents("codex", root)).toBeUndefined();

    await mkdir(join(root, ".opencode", "plugins"), { recursive: true });
    await writeFile(
      join(root, ".opencode", "plugins", "kodel-hooks.ts"),
      opencodePluginSource("kodel hook opencode", ["SessionStart", "Stop"]),
    );
    expect(await readRegisteredEvents("opencode", root)).toEqual(["SessionStart", "Stop"]);
  });

  test("a_file_that_is_not_json_is_no_registration", async () => {
    const root = await project("p");
    await mkdir(join(root, ".codex"));
    await writeFile(join(root, ".codex", "hooks.json"), "// mine\n{");
    expect(await readRegisteredEvents("codex", root)).toBeUndefined();
  });

  test("the_plugin_source_is_valid_and_carries_the_command_and_the_events", () => {
    const source = opencodePluginSource("bun x/main.ts hook opencode", ["SessionStart"]);
    expect(source).toContain('const COMMAND = "bun x/main.ts hook opencode";');
    expect(source).toContain('new Set(["SessionStart"])');
    expect(source).toContain("// kodel:events SessionStart");
    // It must parse as a module.
    new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  });
});

describe("the staleness check", () => {
  test("events_the_registry_wants_and_the_agent_lacks_are_noted_in_the_log", async () => {
    const root = await project("p");
    await mkdir(join(root, ".claude"));
    await writeFile(
      join(root, ".claude", "settings.local.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "kodel hook claude-code" }] }],
        },
      }),
    );
    const registry = defaultHookRegistry();
    await runHook("claude-code", start(root), { now: NOW, registry });
    await expect(readFile(join(root, HOOK_LOG), "utf8")).rejects.toThrow();

    registry.register({ id: "tools", events: ["PreToolUse", "SessionStart"], run: () => {} });
    await runHook("claude-code", start(root), { now: NOW, registry });
    expect(await readFile(join(root, HOOK_LOG), "utf8")).toContain(
      "claude-code: events not registered: PreToolUse; run `kodel init`",
    );
  });

  test("a_hand_made_hook_without_a_registration_by_init_says_nothing", async () => {
    const root = await project("p");
    const registry = defaultHookRegistry();
    registry.register({ id: "tools", events: ["PreToolUse"], run: () => {} });
    await runHook("claude-code", start(root), { now: NOW, registry });
    await expect(readFile(join(root, HOOK_LOG), "utf8")).rejects.toThrow();
  });
});
