/**
 * The docs agree with the code (T-47): what AGENTS.md tells an agent not to run is the registry of the
 * person's commands, no more and no less; `docs/serve.md` carries T-44 as T-47 revised it; and
 * `docs/changes.md` spells the line the refusal of a terminal start prints.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_READ_COMMANDS } from "../src/agent-commands";
import { terminalRefusal, WORKER_PRINT_MIGRATION_LINE } from "../src/agent-profiles";
import { HUMAN_ONLY_COMMANDS, INSIDE_SESSION_REFUSAL } from "../src/human-only";

const REPO = join(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
/** The prose is wrapped by hand: a phrase is looked for across line breaks. */
const flat = (text: string) => text.replace(/\s+/g, " ");

const agentsMd = read("AGENTS.md");

/** The commands a list in backticks names: `pipeline changes apply|discard` is two of them. */
const commandsOf = (text: string): string[] =>
  [...text.matchAll(/`([a-z][a-z |-]*)`/g)].flatMap((match) => {
    const words = (match[1] ?? "").split(" ");
    const last = words.pop() ?? "";
    return last.split("|").map((verb) => [...words, verb].join(" "));
  });

describe("t47 the docs and the registry of the person's commands", () => {
  test("t47_agents_md_lists_the_registrys_human_only_commands", () => {
    // The rule an agent reads: from "Do not run" to the colon that ends the list.
    const rule = /^- Do not run ([\s\S]*?): they\s+refuse/m.exec(agentsMd)?.[1] ?? "";
    expect(commandsOf(rule).sort()).toEqual([...HUMAN_ONLY_COMMANDS].sort());
    // The layout section names the same set.
    const layout = /including human-only commands \(([^)]*)\)/.exec(agentsMd)?.[1] ?? "";
    expect(commandsOf(layout).sort()).toEqual([...HUMAN_ONLY_COMMANDS].sort());
    // What only reads is said to be the agent's, by name, and is in neither list.
    const whole = /^- Do not run [\s\S]*?(?=^- )/m.exec(agentsMd)?.[0] ?? "";
    for (const command of AGENT_READ_COMMANDS) {
      expect(whole).toContain(`\`${command}\``);
      expect(HUMAN_ONLY_COMMANDS).not.toContain(command);
      expect(commandsOf(rule)).not.toContain(command);
    }
    expect(whole).toMatch(/only read and are yours/);
  });

  test("t44_docs_carry_the_revised_text", () => {
    const serve = read("docs/serve.md");
    const decisionAt = serve.indexOf("\n## Decision T-44\n");
    const revisionAt = serve.indexOf("\n## T-44 as revised by T-47\n");
    expect(decisionAt).toBeGreaterThan(0);
    expect(revisionAt).toBeGreaterThan(decisionAt);
    // The decision's own text is the revised one, and holds no line of the old one.
    const decision = flat(serve.slice(decisionAt, revisionAt));
    for (const line of [
      "more agents are working than `max_workers`, unless the excess are workers a person's decision woke",
      "a decided run whose worker ended at the wait is not resumed within two cycles of a free worker place",
      "worker is alive neither goes on nor is reported by the daemon within 2 minutes",
      "except for a worker that ended while its run waited for the person",
      "except a worker a person stopped with `kodel agent stop`: the daemon leaves that one to the person's `s`",
      "a second agent is started for a run whose first agent's process still runs",
    ]) {
      expect(decision, line).toContain(line);
    }
    const OLD = [
      "more worker processes than `max_workers`",
      "a decided run of a worker is not resumed within two cycles",
      "worker processes alive at once",
    ];
    for (const line of OLD) expect(decision, line).not.toContain(line);
    // The old lines are kept in the section that says what replaced them and why, and nowhere else.
    const revision = flat(serve.slice(revisionAt));
    for (const line of OLD) {
      expect(revision, line).toContain(line);
      expect(flat(serve.slice(0, revisionAt)), line).not.toContain(line);
    }
    expect(revision).toContain("`finish`");
    // The two limits and the record's two counts are said as the rule has them.
    const whole = flat(serve);
    expect(whole).toContain("`max_workers` counts agents that are working");
    expect(whole).toContain("holds **no** `max_workers` place");
    expect(whole).toContain("`counts.alive` is every live worker process");
    // No test asserts a line of the old text: this file alone names them.
    const tests = [
      "packages/cli/test",
      "packages/local/test",
      "packages/pipeline-core/test",
      "tests/e2e",
    ].flatMap((dir) =>
      (readdirSync(join(REPO, dir), { recursive: true }) as string[])
        .filter((file) => file.endsWith(".ts"))
        .map((file) => join(dir, file)),
    );
    expect(tests.length).toBeGreaterThan(50);
    for (const file of tests) {
      if (file === join("packages/cli/test", "docs.test.ts")) continue;
      const text = flat(read(file));
      for (const line of OLD) expect(text.includes(line), `${file}: ${line}`).toBe(false);
    }
  });

  test("t47_changes_doc_spells_the_migration_line", () => {
    // One constant: what the refusal of a terminal start prints is what the docs tell a person to commit.
    expect(WORKER_PRINT_MIGRATION_LINE).toBe("engines: { claude: { worker: print } }");
    expect(terminalRefusal("no terminal here")).toContain(WORKER_PRINT_MIGRATION_LINE);
    const changes = read("docs/changes.md");
    expect(changes).toContain(WORKER_PRINT_MIGRATION_LINE);
    expect(flat(changes)).toContain("nothing falls back");
    for (const doc of ["docs/serve.md", "docs/engines.md", "AGENTS.md"]) {
      expect(read(doc), doc).toContain(WORKER_PRINT_MIGRATION_LINE);
    }
  });

  test("t47_docs_name_the_guards_and_the_two_kinds_of_worker", () => {
    // The refusal of the session guard is quoted as the command prints it, and what stays open is said.
    const decisions = flat(read("docs/decisions.md"));
    expect(decisions).toContain(INSIDE_SESSION_REFUSAL);
    expect(decisions).toContain("guards against mistakes, not a security boundary");
    expect(decisions).toContain("`kodel mcp` by hand in a shell is accepted");
    // AGENTS.md keeps the subagent of a fork apart from the agent of a whole run.
    const driver = flat(agentsMd);
    expect(driver).toContain("A **fork worker** is the subagent of a fork");
    expect(driver).toContain("never starts `kodel wait`");
    expect(driver).toContain("A **background agent** is the agent of a whole run");
    expect(driver).toContain("start the wait command exactly as the answer spells it");
  });
});

describe("the docs name the keys of the manager's acting tools", () => {
  // mstart_docs_name_keys: the keys, the tools and what `force` goes past are in docs/decisions.md.
  test("mstart_docs_name_keys", () => {
    const decisions = flat(read("docs/decisions.md"));
    for (const word of [
      "`start_task`",
      "`stop_agent`",
      "`manager_start_task`",
      "`manager_stop_agent`",
      "`decisions.agent`",
    ]) {
      expect(decisions, word).toContain(word);
    }
    expect(decisions).toContain("a start without `kodel task approve`");
    expect(decisions).toContain("With `force: true` it also gives a start **past the limits");
    expect(decisions).toContain("`force` goes past those warnings only");
    expect(decisions).toContain("answers `CONFIG_INVALID` for the whole project config");
    // The same tools are named where roles, the web UI and the agents' rules are documented.
    for (const doc of ["docs/mcp-roles.md", "docs/web.md", "AGENTS.md"]) {
      const text = read(doc);
      expect(text, doc).toContain("manager_start_task");
      expect(text, doc).toContain("manager_stop_agent");
    }
  });
});
