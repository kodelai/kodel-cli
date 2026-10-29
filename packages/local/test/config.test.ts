import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AGENT_LOG,
  DEFAULT_HISTORY,
  defaultAgentLog,
  HISTORY_CATEGORIES,
  KodelError,
} from "@kodel-ai/pipeline-core";
import {
  CONFIG_FILE,
  DEFAULT_AGENTS,
  DEFAULT_WORKTREE_DIR,
  HISTORY_SECTION_KEYS,
  loadConfig,
} from "../src";

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
      decisions: { dialog: false, agent: { gate: false, pipeline_change: false } },
      tasks: {
        enabled: false,
        adapter: "local",
        timeout_s: 30,
        on_run: { mode: "auto" },
        adapters: {},
      },
      history: { ...DEFAULT_HISTORY, agent_log: DEFAULT_AGENT_LOG },
      agents: { subagents: "auto", max_parallel: 8, claim_ttl_s: 900 },
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

  test("t_decisions_defaults_are_all_off", async () => {
    const off = { dialog: false, agent: { gate: false, pipeline_change: false } };
    expect((await loadConfig(dir)).decisions).toEqual(off);
    await write("decisions: {}\n");
    expect((await loadConfig(dir)).decisions).toEqual(off);
    await write("decisions:\n  agent: {}\n");
    expect((await loadConfig(dir)).decisions).toEqual(off);
  });

  test("t_decisions_each_switch_is_read_on_its_own", async () => {
    await write("decisions:\n  dialog: true\n");
    expect((await loadConfig(dir)).decisions).toEqual({
      dialog: true,
      agent: { gate: false, pipeline_change: false },
    });
    await write("decisions:\n  agent:\n    gate: true\n");
    expect((await loadConfig(dir)).decisions).toEqual({
      dialog: false,
      agent: { gate: true, pipeline_change: false },
    });
    await write("decisions:\n  agent:\n    pipeline_change: true\n");
    expect((await loadConfig(dir)).decisions.agent).toEqual({
      gate: false,
      pipeline_change: true,
    });
  });

  test("t_decisions_unknown_key_is_refused_and_ack_has_no_key", async () => {
    expect((await failure("decisions:\n  agent:\n    ack: true\n")).message).toContain("ack");
    expect((await failure("decisions:\n  agent:\n    pipline_change: true\n")).message).toContain(
      "pipline_change",
    );
    expect((await failure("decisions:\n  dialogs: true\n")).message).toContain("dialogs");
    expect((await failure("decision:\n  dialog: true\n")).message).toContain("decision");
  });

  test("t_decisions_non_boolean_is_refused", async () => {
    expect((await failure("decisions:\n  dialog: sometimes\n")).code).toBe("CONFIG_INVALID");
    expect((await failure("decisions:\n  agent:\n    gate: 1\n")).code).toBe("CONFIG_INVALID");
    expect((await failure("decisions:\n  agent: true\n")).code).toBe("CONFIG_INVALID");
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
    const defaults = { ...DEFAULT_HISTORY, agent_log: DEFAULT_AGENT_LOG };
    expect((await loadConfig(dir)).history).toEqual(defaults);
    await write("version: 1\n");
    expect((await loadConfig(dir)).history).toEqual(defaults);
    await write("history: {}\n");
    expect((await loadConfig(dir)).history).toEqual(defaults);
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
      agent_log: DEFAULT_AGENT_LOG,
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
    // `agent_log` is the one section with more than a switch (mode, caps, interval) and is listed apart
    expect([...HISTORY_SECTION_KEYS].sort()).toEqual([...HISTORY_CATEGORIES, "agent_log"].sort());
    expect(Object.keys(DEFAULT_HISTORY).sort()).toEqual([...HISTORY_CATEGORIES].sort());
    for (const category of HISTORY_CATEGORIES) {
      expect(DEFAULT_HISTORY[category].enabled).toBe(true);
      await write(`history:\n  ${category}: { enabled: false }\n`);
      expect((await loadConfig(dir)).history[category].enabled).toBe(false);
    }
  });
});

describe("the agent_log section", () => {
  const agentLog = async (yaml: string) => (await loadConfig(dir)).history.agent_log;

  test("t3bk2_defaults", async () => {
    // on, full, the caps and the bound decided for it, a copy every 10 seconds
    expect(await agentLog("")).toEqual({
      enabled: true,
      mode: "full",
      preview_chars: { user: 4_000, agent: 4_000, tool_input: 4_000, tool_result: 8_000 },
      max_kb: 20_480,
      interval_s: 10,
    });
    await write("history:\n  agent_log: {}\n");
    expect(await agentLog("")).toEqual(DEFAULT_AGENT_LOG);
    // a copy of the defaults, not the constant
    expect(defaultAgentLog()).not.toBe(DEFAULT_AGENT_LOG);
    expect(defaultAgentLog().preview_chars).not.toBe(DEFAULT_AGENT_LOG.preview_chars);
  });

  test("t3bk2_every_key_is_read", async () => {
    await write(
      [
        "history:",
        "  agent_log:",
        "    enabled: false",
        "    mode: metadata",
        "    preview_chars: { agent: 100, tool_result: 0 }",
        "    max_kb: 64",
        "    interval_s: 0",
        "",
      ].join("\n"),
    );
    expect(await agentLog("")).toEqual({
      enabled: false,
      mode: "metadata",
      preview_chars: { user: 4_000, agent: 100, tool_input: 4_000, tool_result: 0 },
      max_kb: 64,
      interval_s: 0,
    });
  });

  test("t3bk2_preview_chars_as_one_number", async () => {
    await write("history:\n  agent_log: { preview_chars: 200 }\n");
    expect((await agentLog(""))?.preview_chars).toEqual({
      user: 200,
      agent: 200,
      tool_input: 200,
      tool_result: 200,
    });
    await write("history:\n  agent_log: { preview_chars: 0 }\n");
    expect((await agentLog(""))?.preview_chars).toEqual({
      user: 0,
      agent: 0,
      tool_input: 0,
      tool_result: 0,
    });
  });

  test("t3bk2_config_rejects_bad_values", async () => {
    for (const bad of [
      "max_kb: 0",
      "max_kb: -1",
      "max_kb: 1.5",
      "mode: everything",
      "interval_s: -1",
      "interval_s: 2.5",
      "interval_s: 100000",
      "preview_chars: -1",
      "preview_chars: 1.5",
      "preview_chars: 99999999",
      "preview_chars: { agent: -5 }",
      "preview_chars: { thought: 5 }",
      "enable: false",
    ]) {
      const error = await failure(`history:\n  agent_log: { ${bad} }\n`);
      expect(error.code).toBe("CONFIG_INVALID");
      expect(error.message).toContain("history.agent_log");
    }
  });
});

describe("t40 the agents section", () => {
  test("t40_config_agents_defaults", async () => {
    expect((await loadConfig(dir)).agents).toEqual({
      subagents: "auto",
      max_parallel: 8,
      claim_ttl_s: 900,
    });
    await write("agents: {}\n");
    expect((await loadConfig(dir)).agents).toEqual(DEFAULT_AGENTS);
    expect(DEFAULT_AGENTS).toEqual({ subagents: "auto", max_parallel: 8, claim_ttl_s: 900 });
  });

  test("t40_config_agents_block_parses", async () => {
    await write("agents:\n  subagents: yes\n  max_parallel: 3\n  claim_ttl_s: 120\n");
    expect((await loadConfig(dir)).agents).toEqual({
      subagents: "yes",
      max_parallel: 3,
      claim_ttl_s: 120,
    });
    await write("agents:\n  subagents: no\n");
    expect((await loadConfig(dir)).agents).toEqual({ ...DEFAULT_AGENTS, subagents: "no" });
  });

  test("t40_config_agents_bad_values_refused", async () => {
    expect((await failure("agents:\n  subagents: maybe\n")).message).toContain("agents.subagents");
    expect((await failure("agents:\n  max_parallel: 0\n")).message).toContain(
      "agents.max_parallel",
    );
    expect((await failure("agents:\n  max_parallel: 1.5\n")).message).toContain(
      "agents.max_parallel",
    );
    expect((await failure("agents:\n  claim_ttl_s: 0\n")).message).toContain("agents.claim_ttl_s");
    expect((await failure("agents:\n  claim_ttl_s: 100000\n")).message).toContain(
      "agents.claim_ttl_s",
    );
    expect((await failure("agents:\n  parallel: true\n")).message).toContain("parallel");
    expect((await failure("agents: true\n")).message).toContain("agents");
  });
});
