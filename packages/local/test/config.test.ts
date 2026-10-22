import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KodelError } from "@kodel-ai/pipeline-core";
import { CONFIG_FILE, DEFAULT_WORKTREE_DIR, loadConfig } from "../src";

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
      tasks: { enabled: false, adapter: "local", timeout_s: 30, adapters: {} },
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
});
