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
}

async function init(person: Person, ...args: string[]) {
  let out = "";
  let err = "";
  const questions: { question: string; choices: Choice[] }[] = [];
  const asked: string[] = [];
  const code = await runCli(["init", ...args], {
    cwd: dir,
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    interactive: person.interactive ?? false,
    environment: {},
    confirm: async (question) => {
      asked.push(question);
      return person.tracker ?? false;
    },
    select: async (question, choices) => {
      questions.push({ question, choices });
      return person.picks?.[questions.length - 1] ?? [];
    },
  });
  return { code, out, err, questions, asked };
}

const read = (rel: string) => readFile(join(dir, rel), "utf8");
const json = async (rel: string) => JSON.parse(await read(rel));
const KODEL_CONFIG = ".kodel/config.yaml";

describe("kodel init", () => {
  test("claude_code_gets_the_server_the_permission_and_the_config", async () => {
    const { code, out } = await init({}, "--agent", "claude-code");
    expect(code).toBe(0);
    expect((await json(".mcp.json")).mcpServers.kodel).toEqual({ command: "kodel", args: ["mcp"] });
    const settings = await json(".claude/settings.json");
    expect(settings.enabledMcpjsonServers).toEqual(["kodel"]);
    expect(settings.permissions.allow).toEqual(["mcp__kodel"]);
    expect(await read(KODEL_CONFIG)).toContain("enabled: false");
    expect(await read(".gitignore")).toContain("/.kodel/runs");
    expect(out).toContain("created");
  });

  test("a_second_run_changes_nothing", async () => {
    const args = ["--agent", "claude-code,codex,opencode"];
    await init({}, ...args);
    const files = [
      ".mcp.json",
      ".claude/settings.json",
      ".codex/config.toml",
      "opencode.json",
      ".gitignore",
    ];
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
    await init({}, "--agent", "claude-code");
    expect(Object.keys((await json(".mcp.json")).mcpServers)).toEqual(["other", "kodel"]);
    const settings = await json(".claude/settings.json");
    expect(settings.model).toBe("m");
    expect(settings.permissions.allow).toEqual(["Bash(ls)", "mcp__kodel"]);
    expect(settings.permissions.deny).toEqual(["Read(.env)"]);
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

  test("settings_are_not_touched_when_the_server_entry_is_kept", async () => {
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { kodel: { command: "mine" } } }),
    );
    const { out } = await init({}, "--agent", "claude-code");
    await expect(read(".claude/settings.json")).rejects.toThrow();
    expect(out).toContain("settings.json was not changed either");
  });

  test("a_value_of_the_wrong_type_is_not_replaced", async () => {
    await mkdir(join(dir, ".claude"));
    const mine = JSON.stringify({ permissions: { allow: "Bash(ls)" } });
    await writeFile(join(dir, ".claude/settings.json"), mine);
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: [] }));
    const { out } = await init({}, "--agent", "claude-code");
    expect(await read(".claude/settings.json")).toBe(mine);
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
  const ctx = (force = false) => ({ root: dir, dryRun: false, force, changes: [] as Change[] });
  const file = ".claude/skills/kodel-x/SKILL.md";

  const launcher = () => SKILLS.find((s) => s.name === "kodel-run")?.text ?? "";

  test("vj7z_kodel_run_is_shipped", () => {
    expect(SKILLS.map((s) => s.name)).toEqual(["kodel-run"]);
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
