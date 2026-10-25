import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "@kodel-ai/pipeline-core/mcp";
import { runCli } from "../src/cli";
import type { Choice } from "../src/init";
import { AGENTS } from "../src/init/agents";
import type { Change } from "../src/init/files";
import { installSkills, SKILLS, type Skill } from "../src/init/skills";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-init-"));
  await mkdir(join(dir, ".git"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Person {
  interactive?: boolean;
  /** The values picked for each question, in turn. */
  picks?: string[][];
  /** The answer to the yes/no question about the task tracker. */
  tracker?: boolean;
  /** The answer to the question about the hooks; an empty line (the default) when not given. */
  hooks?: boolean;
  /** The PATH the command sees. */
  path?: string;
}

async function init(person: Person, ...args: string[]) {
  let out = "";
  let err = "";
  const questions: { question: string; choices: Choice[] }[] = [];
  const asked: string[] = [];
  const hooksAsked: { question: string; defaultYes: boolean | undefined }[] = [];
  const code = await runCli(["init", ...args], {
    cwd: dir,
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    interactive: person.interactive ?? false,
    environment: { PATH: person.path ?? "" },
    confirm: async (question, defaultYes) => {
      if (/hooks/i.test(question)) {
        hooksAsked.push({ question, defaultYes });
        return person.hooks ?? defaultYes ?? false;
      }
      asked.push(question);
      return person.tracker ?? false;
    },
    select: async (question, choices) => {
      questions.push({ question, choices });
      return person.picks?.[questions.length - 1] ?? [];
    },
  });
  return { code, out, err, questions, asked, hooksAsked };
}

const read = (rel: string) => readFile(join(dir, rel), "utf8");
const json = async (rel: string) => JSON.parse(await read(rel));
const KODEL_CONFIG = ".kodel/config.yaml";

describe("kodel init", () => {
  test("claude_code_gets_the_server_and_the_config_but_no_permission", async () => {
    const { code, out } = await init({}, "--agent", "claude-code");
    expect(code).toBe(0);
    expect((await json(".mcp.json")).mcpServers.kodel).toEqual({ command: "kodel", args: ["mcp"] });
    await expect(read(".claude/settings.json")).rejects.toThrow();
    const local = await read(".claude/settings.local.json");
    expect(local).not.toContain("enabledMcpjsonServers");
    expect(local).not.toContain("mcp__kodel");
    expect(await read(KODEL_CONFIG)).toContain("enabled: false");
    expect(await read(".gitignore")).toContain("/.kodel/runs");
    expect(out).toContain("created");

    await rm(join(dir, ".claude"), { recursive: true });
    await init({}, "--agent", "claude-code", "--no-hooks");
    await expect(read(".claude/settings.json")).rejects.toThrow();
    await expect(read(".claude/settings.local.json")).rejects.toThrow();
  });

  test("init_tells_the_person_to_enable_the_server_and_allow_its_tools", async () => {
    const { out } = await init({}, "--agent", "claude-code");
    expect(out).toContain("note: Claude Code:");
    expect(out).toContain("enabledMcpjsonServers");
    expect(out).toContain("mcp__kodel");
    expect(out).toContain("settings.local.json");

    const others = await init({}, "--agent", "codex,opencode");
    expect(others.out).not.toContain("enabledMcpjsonServers");
    expect(others.out).not.toContain("mcp__kodel");

    const mixed = await init({}, "--agent", "claude-code,codex");
    expect(mixed.out.split("mcp__kodel").length - 1).toBe(1);
    expect((await init({}, "--agent", "claude-code", "--dry-run")).out).toContain("mcp__kodel");
  });

  test("the_next_line_asks_to_approve_the_server_for_claude_code", async () => {
    expect((await init({}, "--agent", "claude-code")).out).toContain(
      "next: approve the kodel server",
    );
    const codexOnly = await init({}, "--agent", "codex");
    expect(codexOnly.out).toContain("next: restart the agent");
    expect(codexOnly.out).not.toContain("approve");
  });

  test("a_second_run_changes_nothing", async () => {
    const args = ["--agent", "claude-code,codex,opencode"];
    await init({}, ...args);
    const files = [".mcp.json", ".codex/config.toml", "opencode.json", ".gitignore"];
    const before = await Promise.all(files.map(read));
    const again = await init({}, ...args);
    expect(await Promise.all(files.map(read))).toEqual(before);
    expect(again.out).not.toMatch(/created|updated/);
  });

  test("what_the_person_wrote_stays", async () => {
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } } }),
    );
    await mkdir(join(dir, ".claude"));
    await writeFile(
      join(dir, ".claude/settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls)"], deny: ["Read(.env)"] }, model: "m" }),
    );
    await writeFile(join(dir, ".gitignore"), "node_modules\n");
    const mineSettings = await read(".claude/settings.json");
    await init({}, "--agent", "claude-code");
    expect(Object.keys((await json(".mcp.json")).mcpServers)).toEqual(["other", "kodel"]);
    expect(await read(".claude/settings.json")).toBe(mineSettings);
    expect(await read(".gitignore")).toMatch(/^node_modules\n\n# Kodel/);
  });

  test("a_file_that_is_not_plain_json_is_left_alone", async () => {
    await writeFile(join(dir, ".mcp.json"), '{ // mine\n "mcpServers": {} }');
    const { out } = await init({}, "--agent", "claude-code");
    expect(await read(".mcp.json")).toBe('{ // mine\n "mcpServers": {} }');
    expect(out).toContain("skipped");
  });

  test("a_server_the_person_set_up_differently_stays_unless_forced", async () => {
    const mine = {
      mcpServers: { kodel: { command: "bun", args: ["main.ts", "mcp"], env: { A: "1" } } },
    };
    await writeFile(join(dir, ".mcp.json"), JSON.stringify(mine));
    await writeFile(
      join(dir, "opencode.json"),
      JSON.stringify({ mcp: { kodel: { type: "local", command: ["x"] } } }),
    );
    const kept = await init({}, "--agent", "claude-code,opencode");
    expect(await json(".mcp.json")).toEqual(mine);
    expect((await json("opencode.json")).mcp.kodel.command).toEqual(["x"]);
    expect(kept.out).toContain("a different");
    await init({}, "--agent", "claude-code,opencode", "--force");
    expect((await json(".mcp.json")).mcpServers.kodel).toEqual({ command: "kodel", args: ["mcp"] });
    expect((await json("opencode.json")).mcp.kodel.command).toEqual(["kodel", "mcp"]);
  });

  test("an_old_grant_written_by_an_earlier_init_stays", async () => {
    await mkdir(join(dir, ".claude"));
    const old = JSON.stringify({
      enabledMcpjsonServers: ["kodel"],
      permissions: { allow: ["mcp__kodel"] },
    });
    await writeFile(join(dir, ".claude/settings.json"), old);
    await init({}, "--agent", "claude-code");
    expect(await read(".claude/settings.json")).toBe(old);
  });

  test("settings_are_not_touched_when_the_server_entry_is_kept", async () => {
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { kodel: { command: "mine" } } }),
    );
    const { out } = await init({}, "--agent", "claude-code");
    await expect(read(".claude/settings.json")).rejects.toThrow();
    expect(out).not.toContain("mcp__kodel");
    expect(out).toContain("a different");
  });

  test("no_enable_hint_when_mcp_json_is_not_plain_json", async () => {
    await writeFile(join(dir, ".mcp.json"), '{ // mine\n "mcpServers": {} }');
    const { out } = await init({}, "--agent", "claude-code");
    expect(out).not.toContain("mcp__kodel");
  });

  test("a_json_value_of_the_wrong_type_is_not_replaced", async () => {
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: [] }));
    const { out } = await init({}, "--agent", "claude-code");
    expect(await read(".mcp.json")).toBe(JSON.stringify({ mcpServers: [] }));
    expect(out).toContain("is not an object");
  });

  test("a_block_with_one_marker_missing_is_not_touched", async () => {
    await mkdir(join(dir, ".codex"));
    const mine = "# kodel:begin\nmy own lines\n";
    await writeFile(join(dir, ".codex/config.toml"), mine);
    const { out } = await init({}, "--agent", "codex");
    expect(await read(".codex/config.toml")).toBe(mine);
    expect(out).toContain("marker line is missing");
  });

  test("a_hand_written_codex_table_with_quotes_is_found", async () => {
    await mkdir(join(dir, ".codex"));
    const mine = '[mcp_servers."kodel".env]\nA = "1"\n';
    await writeFile(join(dir, ".codex/config.toml"), mine);
    await init({}, "--agent", "codex");
    expect(await read(".codex/config.toml")).toBe(mine);
  });

  test("outside_a_git_root_the_ignore_lines_are_reported", async () => {
    await rm(join(dir, ".git"), { recursive: true });
    const { out } = await init({}, "--agent", "claude-code");
    expect(out).toContain("not the top of a git repository");
    await expect(read(".gitignore")).rejects.toThrow();
  });

  test("an_existing_config_is_not_rewritten", async () => {
    await mkdir(join(dir, ".kodel"));
    await writeFile(join(dir, KODEL_CONFIG), "# mine\nworktree:\n  mode: off\n");
    const { out } = await init({}, "--agent", "claude-code", "--tasks");
    expect(await read(KODEL_CONFIG)).toBe("# mine\nworktree:\n  mode: off\n");
    expect(out).toContain("tasks are off in the existing file");
  });

  test("tasks_flag_turns_the_tracker_on_without_asking", async () => {
    const { asked } = await init({ interactive: true, picks: [["claude-code"]] }, "--tasks");
    expect(await read(KODEL_CONFIG)).toContain("enabled: true");
    expect(asked).toEqual([]);
  });

  test("codex_and_opencode_are_written_and_marked_unchecked", async () => {
    const { out } = await init(
      {},
      "--agent",
      "codex,opencode",
      "--server-command",
      "bun run kodel mcp",
    );
    expect(await read(".codex/config.toml")).toContain('args = ["run","kodel","mcp"]');
    expect((await json("opencode.json")).mcp.kodel).toEqual({
      type: "local",
      command: ["bun", "run", "kodel", "mcp"],
      enabled: true,
    });
    expect(out).toContain("not checked on the real agent yet");
  });

  test("a_hand_written_codex_server_is_not_replaced", async () => {
    await mkdir(join(dir, ".codex"));
    await writeFile(join(dir, ".codex/config.toml"), '[mcp_servers.kodel]\ncommand = "mine"\n');
    await init({}, "--agent", "codex");
    expect(await read(".codex/config.toml")).toBe('[mcp_servers.kodel]\ncommand = "mine"\n');
  });

  test("dry_run_writes_nothing", async () => {
    const { out } = await init({}, "--agent", "claude-code", "--dry-run");
    expect(out).toContain("would be created");
    await expect(read(".mcp.json")).rejects.toThrow();
  });

  test("without_a_terminal_the_agents_found_are_taken_and_none_is_an_error", async () => {
    const none = await init({}, "--yes");
    expect(none.code).toBe(1);
    expect(none.err).toContain("name one with --agent");
    await mkdir(join(dir, ".codex"));
    expect((await init({}, "--yes")).code).toBe(0);
    expect(await read(".codex/config.toml")).toContain("mcp_servers.kodel");
    await expect(read(".mcp.json")).rejects.toThrow();
  });

  test("an_unknown_agent_is_refused", async () => {
    const { code, err } = await init({}, "--agent", "emacs");
    expect(code).toBe(1);
    expect(err).toContain('unknown agent "emacs"');
  });

  test("interactive_asks_for_the_agents_and_then_for_the_task_tracker", async () => {
    await mkdir(join(dir, ".claude"));
    const { code, questions, asked } = await init({
      interactive: true,
      picks: [["claude-code"]],
      tracker: true,
    });
    expect(code).toBe(0);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.choices.find((c) => c.value === "claude-code")?.checked).toBe(true);
    expect(questions[0]?.choices.find((c) => c.value === "codex")?.checked).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("local task tracker");
    expect(await read(KODEL_CONFIG)).toContain("enabled: true");
  });

  test("the_tracker_stays_off_when_the_person_says_no", async () => {
    await init({ interactive: true, picks: [["claude-code"]], tracker: false });
    expect(await read(KODEL_CONFIG)).toContain("enabled: false");
  });

  test("yes_asks_nothing_even_at_a_terminal", async () => {
    const { questions, asked, code } = await init(
      { interactive: true },
      "--yes",
      "--agent",
      "claude-code",
    );
    expect(code).toBe(0);
    expect(questions).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe("skills", () => {
  const skill: Skill = { name: "kodel-x", text: "---\nname: kodel-x\n---\nbody\n" };
  const claude = AGENTS[0] as (typeof AGENTS)[number];
  const ctx = (force = false) => ({
    root: dir,
    dryRun: false,
    force,
    changes: [] as Change[],
    hints: [] as string[],
  });
  const file = ".claude/skills/kodel-x/SKILL.md";

  const launcher = () => SKILLS.find((s) => s.name === "kodel-run")?.text ?? "";

  test("vj7z_kodel_run_is_shipped", () => {
    expect(SKILLS.map((s) => s.name)).toEqual(["kodel-run", "kodel-design"]);
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(launcher())?.[1] ?? "";
    expect(frontmatter).toContain("name: kodel-run\n");
    expect(frontmatter).toMatch(/^description: \S/m);
  });

  test("vj7z_kodel_run_names_the_tools_that_exist", () => {
    const known = new Set(TOOLS.map((t) => t.name));
    const named = launcher().match(/\bpipeline_[a-z_]+/g) ?? [];
    expect(named).toContain("pipeline_list");
    expect(named).toContain("pipeline_start");
    for (const name of named) expect(known.has(name)).toBe(true);
  });

  test("vj7z_kodel_run_does_not_copy_the_rules", () => {
    for (const forbidden of ["gate", "ack", "seal", "resume", "pipeline_complete_step"]) {
      expect(launcher()).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
    expect(launcher()).toContain("instructions the server sent");
    expect(launcher()).toMatch(/lists no pipelines, tell the person and stop/);
  });

  test("vj7z_init_installs_kodel_run_for_every_agent", async () => {
    const args = ["--agent", "claude-code,codex,opencode"];
    expect((await init({}, ...args)).code).toBe(0);
    const files = [
      ".claude/skills/kodel-run/SKILL.md",
      ".agents/skills/kodel-run/SKILL.md",
      ".opencode/skills/kodel-run/SKILL.md",
    ];
    for (const rel of files) expect(await read(rel)).toContain("name: kodel-run");
    const before = await Promise.all(files.map(read));
    await init({}, ...args);
    expect(await Promise.all(files.map(read))).toEqual(before);
  });

  const designer = () => SKILLS.find((s) => s.name === "kodel-design")?.text ?? "";

  test("t2t8e_kodel_design_is_shipped", () => {
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(designer())?.[1] ?? "";
    expect(frontmatter).toContain("name: kodel-design\n");
    expect(frontmatter).toMatch(/^description: \S/m);
  });

  test("t2t8e_kodel_design_names_the_tools_that_exist", () => {
    const known = new Set(TOOLS.map((t) => t.name));
    const named = designer().match(/\bpipeline_[a-z_]+/g) ?? [];
    for (const name of ["pipeline_docs", "pipeline_propose_change"]) expect(named).toContain(name);
    for (const name of named) expect(known.has(name)).toBe(true);
    expect(designer()).toContain("pipeline-design");
  });

  test("t2t8e_kodel_design_proposes_and_never_writes_pipelines", () => {
    expect(designer()).toContain("without `run_id`");
    expect(designer()).toContain("never write into `.kodel/pipelines/`");
    for (const forbidden of ["gate", "ack", "seal", "resume", "proposals apply"]) {
      expect(designer()).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  test("t2t8e_init_installs_kodel_design_for_every_agent", async () => {
    const args = ["--agent", "claude-code,codex,opencode"];
    expect((await init({}, ...args)).code).toBe(0);
    const files = [".claude/skills", ".agents/skills", ".opencode/skills"].map(
      (d) => `${d}/kodel-design/SKILL.md`,
    );
    for (const rel of files) {
      const text = await read(rel);
      expect(text).toContain("name: kodel-design");
      expect(text).toContain(designer().trimEnd());
    }
    const before = await Promise.all(files.map(read));
    await init({}, ...args);
    expect(await Promise.all(files.map(read))).toEqual(before);
  });

  test("a_skill_is_installed_updated_and_an_edited_copy_is_kept", async () => {
    const first = ctx();
    await installSkills(first, claude, [skill]);
    expect(first.changes[0]?.status).toBe("created");
    expect(await read(file)).toContain("body");

    const update = ctx();
    await installSkills(update, claude, [
      { ...skill, text: skill.text.replace("body", "new body") },
    ]);
    expect(update.changes[0]?.status).toBe("updated");
    expect(await read(file)).toContain("new body");

    await writeFile(join(dir, file), `${await read(file)}my line\n`);
    const kept = ctx();
    await installSkills(kept, claude, [skill]);
    expect(kept.changes[0]?.status).toBe("skipped");
    expect(await read(file)).toContain("my line");

    const forced = ctx(true);
    await installSkills(forced, claude, [skill]);
    expect(forced.changes[0]?.status).toBe("updated");
    expect(await read(file)).not.toContain("my line");
  });

  test("a_skill_kodel_did_not_write_is_kept", async () => {
    await mkdir(join(dir, ".claude/skills/kodel-x"), { recursive: true });
    await writeFile(join(dir, file), "mine\n");
    const c = ctx();
    await installSkills(c, claude, [skill]);
    expect(c.changes[0]?.status).toBe("skipped");
    expect(await read(file)).toBe("mine\n");
  });
});

describe("kodel init hooks", () => {
  const SETTINGS = ".claude/settings.local.json";
  const claudeHooks = async () => (await json(SETTINGS)).hooks as Record<string, unknown[]>;
  const commandsOf = (groups: unknown[]) =>
    groups.flatMap((g) => (g as { hooks: { command: string }[] }).hooks.map((h) => h.command));

  test("hooks_are_registered_by_default_for_the_chosen_agent", async () => {
    await init({}, "--agent", "claude-code");
    const hooks = await claudeHooks();
    expect(Object.keys(hooks)).toEqual(["SessionStart"]);
    expect(commandsOf(hooks.SessionStart ?? [])).toEqual(["kodel-hook claude-code"]);
    const ignore = await read(".gitignore");
    for (const line of [SETTINGS, ".kodel/sessions.jsonl", ".kodel/hooks.log"]) {
      expect(ignore.split("\n")).toContain(`/${line}`);
    }
  });

  test("t_elicit_init_never_registers_a_hook_that_could_answer_a_dialog_for_the_person", async () => {
    await init({}, "--agent", "claude-code,codex,opencode");
    // The hook file is really there, so a text without the word means something.
    expect(await read(SETTINGS)).toContain("SessionStart");
    for (const file of [SETTINGS, ".claude/settings.json", ".codex/hooks.json"]) {
      const text = await read(file).catch(() => "");
      expect(text).not.toMatch(/Elicitation/i);
    }
    expect(await read(".opencode/plugins/kodel-hooks.ts").catch(() => "")).not.toMatch(
      /Elicitation/i,
    );
  });

  test("yes_and_no_terminal_register_the_hooks_too", async () => {
    await init({ interactive: true }, "--agent", "claude-code", "--yes");
    expect(Object.keys(await claudeHooks())).toEqual(["SessionStart"]);
  });

  test("no_hooks_leaves_every_hook_file_and_ignore_line_alone", async () => {
    const { out } = await init({}, "--agent", "claude-code,codex,opencode", "--no-hooks");
    await expect(read(SETTINGS)).rejects.toThrow();
    await expect(read(".codex/hooks.json")).rejects.toThrow();
    await expect(read(".opencode/plugins/kodel-hooks.ts")).rejects.toThrow();
    expect(await read(".gitignore")).not.toContain("sessions.jsonl");
    expect(out).not.toContain("trust");
  });

  test("the_question_defaults_to_yes_and_a_no_is_honoured", async () => {
    const yes = await init({ interactive: true, picks: [["claude-code"]] });
    expect(yes.hooksAsked).toHaveLength(1);
    expect(yes.hooksAsked[0]?.defaultYes).toBe(true);
    expect(Object.keys(await claudeHooks())).toEqual(["SessionStart"]);

    await rm(join(dir, ".claude"), { recursive: true });
    const no = await init({ interactive: true, picks: [["claude-code"]], hooks: false });
    expect(no.hooksAsked).toHaveLength(1);
    await expect(read(SETTINGS)).rejects.toThrow();
  });

  test("the_hooks_flag_asks_nothing", async () => {
    const { hooksAsked } = await init({ interactive: true, picks: [["claude-code"]] }, "--hooks");
    expect(hooksAsked).toEqual([]);
    expect(Object.keys(await claudeHooks())).toEqual(["SessionStart"]);
  });

  test("dry_run_lists_the_hook_files_and_writes_nothing", async () => {
    const { out } = await init({}, "--agent", "claude-code,codex,opencode", "--dry-run");
    expect(out).toContain(SETTINGS);
    expect(out).toContain(".codex/hooks.json");
    expect(out).toContain(".opencode/plugins/kodel-hooks.ts");
    await expect(read(SETTINGS)).rejects.toThrow();
    await expect(read(".gitignore")).rejects.toThrow();
  });

  test("the_persons_own_hooks_stay_and_ours_is_added_once", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      join(dir, SETTINGS),
      JSON.stringify({
        permissions: { allow: ["Bash(ls)"] },
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }],
          Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
        },
      }),
    );
    await init({}, "--agent", "claude-code");
    const again = await init({}, "--agent", "claude-code");
    const settings = await json(SETTINGS);
    expect(settings.permissions.allow).toEqual(["Bash(ls)"]);
    expect(commandsOf(settings.hooks.SessionStart)).toEqual([
      "echo mine",
      "kodel-hook claude-code",
    ]);
    expect(commandsOf(settings.hooks.Stop)).toEqual(["echo stop"]);
    expect(again.out).toMatch(/unchanged\s+\.claude\/settings\.local\.json/);
  });

  test("a_rerun_changes_nothing_and_the_ignore_lines_are_added_once", async () => {
    await init({}, "--agent", "claude-code,codex,opencode");
    const files = [SETTINGS, ".codex/hooks.json", ".opencode/plugins/kodel-hooks.ts", ".gitignore"];
    const before = await Promise.all(files.map(read));
    await init({}, "--agent", "claude-code,codex,opencode");
    expect(await Promise.all(files.map(read))).toEqual(before);
    const ignore = (await read(".gitignore")).split("\n");
    expect(ignore.filter((line) => line === "/.kodel/sessions.jsonl")).toHaveLength(1);
  });

  test("broken_json_and_comments_are_skipped_with_a_note", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    for (const text of ["{ not json", '{\n  // mine\n  "hooks": {},\n}\n']) {
      await writeFile(join(dir, SETTINGS), text);
      const { out } = await init({}, "--agent", "claude-code");
      expect(await read(SETTINGS)).toBe(text);
      expect(out).toMatch(/skipped\s+\.claude\/settings\.local\.json/);
    }
  });

  test("the_hook_command_is_the_server_command_with_hook_for_mcp", async () => {
    await init(
      {},
      "--agent",
      "claude-code",
      "--server-command",
      "bun packages/cli/src/main.ts mcp",
    );
    const hooks = await claudeHooks();
    expect(commandsOf(hooks.SessionStart ?? [])).toEqual([
      "bun packages/cli/src/main.ts hook claude-code",
    ]);
  });

  test("codex_is_told_to_trust_the_hook_every_time_also_on_a_rerun_and_a_dry_run", async () => {
    const first = await init({}, "--agent", "codex");
    expect(first.out).toContain("Codex does not run project hooks until you trust them");
    expect(first.out).toContain("/hooks");
    const hooks = await json(".codex/hooks.json");
    expect(commandsOf(hooks.hooks.SessionStart)).toEqual(["kodel-hook codex"]);
    expect((await init({}, "--agent", "codex")).out).toContain("until you trust them");
    expect((await init({}, "--agent", "codex", "--dry-run")).out).toContain("until you trust them");
  });

  test("opencode_gets_a_plugin_and_a_foreign_file_is_not_replaced", async () => {
    const file = ".opencode/plugins/kodel-hooks.ts";
    await init({}, "--agent", "opencode");
    const plugin = await read(file);
    expect(plugin).toContain("// kodel:events SessionStart");
    expect(plugin).toContain('"kodel-hook opencode"');

    await writeFile(join(dir, file), "mine\n");
    const kept = await init({}, "--agent", "opencode");
    expect(await read(file)).toBe("mine\n");
    expect(kept.out).toMatch(/skipped\s+\.opencode\/plugins\/kodel-hooks\.ts/);
    await init({}, "--agent", "opencode", "--force");
    expect(await read(file)).toBe(plugin);
  });

  test("a_missing_kodel_on_the_path_is_warned_about_and_a_found_one_is_not", async () => {
    const missing = await init({ path: "/nonexistent" }, "--agent", "claude-code");
    expect(missing.out).toContain("`kodel-hook` is not on the PATH");
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, "bin", "kodel-hook"), "#!/bin/sh\n", { mode: 0o755 });
    const found = await init({ path: join(dir, "bin") }, "--agent", "claude-code");
    expect(found.out).not.toContain("is not on the PATH");
  });

  test("hooks_are_not_called_unchecked_now_that_the_real_agent_tests_pass_but_the_codex_sandbox_is_named", async () => {
    const { out } = await init({}, "--agent", "claude-code,codex,opencode");
    expect(out).not.toContain("the hooks for");
    // The MCP setup of Codex and OpenCode is still the unchecked one.
    expect(out).toContain("the setup for Codex, OpenCode is not checked on the real agent yet");
    expect(out).toContain("read-only session the hook cannot write .kodel/sessions.jsonl");
  });
});
