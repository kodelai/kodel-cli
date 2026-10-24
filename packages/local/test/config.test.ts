import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HISTORY, HISTORY_CATEGORIES, KodelError } from "@kodel-ai/pipeline-core";
import { CONFIG_FILE, DEFAULT_WORKTREE_DIR, HISTORY_SECTION_KEYS, loadConfig } from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (text: string) => writeFile(join(dir, CONFIG_FILE), text);
const failure = async (text: string) => {
  await write(text);
  const error = await loadConfig(dir).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(KodelError);
  return error as KodelError;
};

describe("the project config", () => {
  test("tNN_config_defaults_when_there_is_no_file_or_it_is_empty", async () => {
    const expected = { mode: "auto" as const, dir: DEFAULT_WORKTREE_DIR };
    expect((await loadConfig(dir)).worktree).toEqual(expected);
    await write("");
    expect((await loadConfig(dir)).worktree).toEqual(expected);
    await write("version: 1\n");
    expect(await loadConfig(dir)).toEqual({
      version: "1.0.0",
      worktree: expected,
      pipeline: { uncommitted: "ask" },
      agent_hints: { wait: true },
      tasks: {
        enabled: false,
        adapter: "local",
        timeout_s: 30,
        on_run: { mode: "auto" },
        adapters: {},
      },
      history: DEFAULT_HISTORY,
    });
  });

  test("t3_t4_tasks_are_off_by_default_and_the_settings_of_each_adapter_have_their_own_block", async () => {
    expect((await loadConfig(dir)).tasks.enabled).toBe(false);
    await write(
      [
        "tasks:",
        "  enabled: true",
        "  adapter: jira",
        "  timeout_s: 10",
        "  adapters:",
        "    local:",
        "      prefix: KDL",
        "    jira:",
        "      site: https://acme.atlassian.net",
        "",
      ].join("\n"),
    );
    expect((await loadConfig(dir)).tasks).toEqual({
      enabled: true,
      adapter: "jira",
      timeout_s: 10,
      on_run: { mode: "auto" },
      // Both blocks are kept as they are: whichever adapter is in use checks its own.
      adapters: { local: { prefix: "KDL" }, jira: { site: "https://acme.atlassian.net" } },
    });
  });

  test("t4_a_misspelled_core_key_under_tasks_is_refused_by_name", async () => {
    const error = await failure("tasks:\n  enable: true\n");
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("enable");
    expect((await failure("tasks:\n  timeout_s: 0\n")).code).toBe("CONFIG_INVALID");
    expect((await failure("tasks:\n  adapter: ''\n")).code).toBe("CONFIG_INVALID");
  });

  test("t5_an_unknown_top_level_key_names_a_newer_kodel_as_the_likely_cause", async () => {
    const error = await failure("taskz:\n  enabled: true\n");
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("taskz");
    expect(error.message).toContain("newer kodel");
    expect(error.message).toContain("upgrade kodel or remove the key");
    // A key deeper down is a typo, not a newer file: no such hint there.
    expect((await failure("worktree:\n  mod: off\n")).message).not.toContain("newer kodel");
  });

  test("tNN_config_reads_what_to_do_with_an_uncommitted_pipeline", async () => {
    await write("pipeline:\n  uncommitted: working\n");
    expect((await loadConfig(dir)).pipeline).toEqual({ uncommitted: "working" });
    expect((await failure("pipeline:\n  uncommitted: sometimes\n")).code).toBe("CONFIG_INVALID");
    expect((await failure("pipeline:\n  uncomitted: working\n")).message).toContain("uncomitted");
  });

  test("tNN_config_can_turn_off_the_offer_of_kodel_wait", async () => {
    expect((await loadConfig(dir)).agent_hints).toEqual({ wait: true });
    await write("agent_hints:\n  wait: false\n");
    expect((await loadConfig(dir)).agent_hints).toEqual({ wait: false });
    await write("agent_hints: {}\n");
    expect((await loadConfig(dir)).agent_hints).toEqual({ wait: true });
    // A word is not a boolean, and a misspelled key is named, not ignored.
    expect((await failure("agent_hints:\n  wait: never\n")).code).toBe("CONFIG_INVALID");
    expect((await failure("agent_hints:\n  waits: false\n")).message).toContain("waits");
    expect((await failure("agent_hint:\n  wait: false\n")).message).toContain("agent_hint");
  });

  test("tNN_config_reads_mode_and_dir", async () => {
    await write("version: 1\nworktree:\n  mode: off\n  dir: /somewhere/else\n");
    expect((await loadConfig(dir)).worktree).toEqual({ mode: "off", dir: "/somewhere/else" });
  });

  test("tNN_config_unknown_key_is_refused_by_name", async () => {
    expect((await failure("worktrees:\n  mode: off\n")).message).toContain("worktrees");
    const nested = await failure("worktree:\n  mod: off\n");
    expect(nested.message).toContain("mod");
    expect(nested.code).toBe("CONFIG_INVALID");
    expect(nested.message).toContain(CONFIG_FILE);
  });

  test("tNN_config_bad_values_say_what_is_wrong", async () => {
    expect((await failure("worktree:\n  mode: sometimes\n")).code).toBe("CONFIG_INVALID");
    expect((await failure("worktree:\n  dir: ''\n")).code).toBe("CONFIG_INVALID");
    expect((await failure("version: nope\n")).message).toContain("version");
    expect((await failure("worktree: [unclosed\n")).message).toContain("YAML");
  });

  test("tNN_config_newer_version_names_the_version_and_says_to_upgrade", async () => {
    const error = await failure("version: 9\n");
    expect(error.code).toBe("UNSUPPORTED_FORMAT");
    expect(error.message).toContain("9.0.0");
    expect(error.message).toContain("upgrade");
  });
  test("run_task_on_run_mode_defaults_to_auto_and_a_bad_value_names_the_three", async () => {
    await write("tasks:\n  enabled: true\n  on_run:\n    mode: ask\n");
    expect((await loadConfig(dir)).tasks.on_run).toEqual({ mode: "ask" });
    await write("tasks:\n  enabled: true\n  on_run: {}\n");
    expect((await loadConfig(dir)).tasks.on_run).toEqual({ mode: "auto" });
    await write("tasks:\n  on_run:\n    mode: sometimes\n");
    await expect(loadConfig(dir)).rejects.toThrow(/auto.*ask.*disabled/);
    await write("tasks:\n  on_run:\n    mod: ask\n");
    await expect(loadConfig(dir)).rejects.toThrow(/mod/);
  });
});

describe("the history section", () => {
  test("history_defaults_when_there_is_no_file_or_no_section", async () => {
    expect((await loadConfig(dir)).history).toEqual(DEFAULT_HISTORY);
    await write("version: 1\n");
    expect((await loadConfig(dir)).history).toEqual(DEFAULT_HISTORY);
    await write("history: {}\n");
    expect((await loadConfig(dir)).history).toEqual(DEFAULT_HISTORY);
  });

  test("history_every_key_is_read_and_the_rest_keep_their_defaults", async () => {
    await write(
      [
        "history:",
        "  changes: { enabled: false, exclude: ['**/.env*', 'secrets/**'], max_kb: 8 }",
        "  output: { enabled: false, max_kb: 2 }",
        "  prompts: { enabled: false }",
        "  executor: { enabled: false }",
        "  tool_log: { enabled: false }",
        "",
      ].join("\n"),
    );
    expect((await loadConfig(dir)).history).toEqual({
      changes: { enabled: false, exclude: ["**/.env*", "secrets/**"], max_kb: 8 },
      output: { enabled: false, max_kb: 2 },
      prompts: { enabled: false },
      executor: { enabled: false },
      tool_log: { enabled: false },
    });
    await write("history:\n  changes: { exclude: ['a/**'] }\n");
    expect((await loadConfig(dir)).history.changes).toEqual({
      enabled: true,
      exclude: ["a/**"],
      max_kb: 512,
    });
    await write("history:\n  output: { enabled: false }\n");
    expect((await loadConfig(dir)).history.output).toEqual({ enabled: false, max_kb: 64 });
  });

  test("history_an_unknown_key_is_refused_by_name", async () => {
    expect((await failure("history:\n  change: { enabled: false }\n")).message).toContain("change");
    const nested = await failure("history:\n  changes: { enable: false }\n");
    expect(nested.code).toBe("CONFIG_INVALID");
    expect(nested.message).toContain("enable");
    expect((await failure("history:\n  prompts: { max_kb: 1 }\n")).message).toContain("max_kb");
  });

  test("history_wrong_types_and_limits_are_refused", async () => {
    for (const text of [
      "history:\n  changes: { enabled: 'yes' }\n",
      "history:\n  changes: { exclude: 'a' }\n",
      "history:\n  changes: { exclude: [1] }\n",
      "history:\n  changes: { max_kb: 0 }\n",
      "history:\n  changes: { max_kb: -1 }\n",
      "history:\n  changes: { max_kb: 1.5 }\n",
      "history:\n  output: { max_kb: 0 }\n",
      "history:\n  output: { max_kb: '5' }\n",
      "history: yes\n",
      "history:\n  tool_log: true\n",
    ]) {
      expect((await failure(text)).code).toBe("CONFIG_INVALID");
    }
  });

  test("history_a_bad_exclude_glob_is_refused_with_its_place", async () => {
    for (const glob of ["''", '"a\\0b"', `'${"a".repeat(2000)}'`]) {
      const error = await failure(`history:\n  changes: { exclude: [${glob}] }\n`);
      expect(error.code).toBe("CONFIG_INVALID");
      expect(error.message).toContain("history.changes.exclude");
    }
  });

  test("history_the_exclude_list_has_a_bound", async () => {
    const globs = (n: number) => Array.from({ length: n }, (_, i) => `'d${i}/**'`).join(", ");
    await write(`history:\n  changes: { exclude: [${globs(256)}] }\n`);
    expect((await loadConfig(dir)).history.changes.exclude.length).toBe(256);
    expect((await failure(`history:\n  changes: { exclude: [${globs(257)}] }\n`)).code).toBe(
      "CONFIG_INVALID",
    );
  });

  test("every_history_category_has_a_switch", async () => {
    // The categories the engine can write, the section of the schema and the defaults must list the
    // same ones, and each must have an `enabled` key.
    expect([...HISTORY_SECTION_KEYS].sort()).toEqual([...HISTORY_CATEGORIES].sort());
    expect(Object.keys(DEFAULT_HISTORY).sort()).toEqual([...HISTORY_CATEGORIES].sort());
    for (const category of HISTORY_CATEGORIES) {
      expect(DEFAULT_HISTORY[category].enabled).toBe(true);
      await write(`history:\n  ${category}: { enabled: false }\n`);
      expect((await loadConfig(dir)).history[category].enabled).toBe(false);
    }
  });
});
