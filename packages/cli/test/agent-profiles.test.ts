/**
 * The profile table (T-45, TASK-EKAV step 4): the one `claude` entry, its argv in a terminal and as a
 * print process, the prompt rule, the lists, and the argv read back before a start.
 */
import { describe, expect, test } from "bun:test";
import { configEngineResolver, WORKER_ENGINES } from "@kodel-ai/local";
import {
  AGENT_PROFILES,
  type AgentProfile,
  agentProfile,
  DEFAULT_WORKER_MECHANISM,
  workerMechanismOf,
  workerProgramOf,
} from "../src/agent-profiles";
import { WORKER_DENIED, WORKER_DENIED_PATHS, workerArgv } from "../src/claude-worker";

const ID = "11111111-2222-4333-8444-555555555555";
const ROOT = "/proj";
const BASE = "/home/u/.kodel";
const SERVED = ["pipeline_next_step", "pipeline_complete_step", "task_get"];

const claude = (): AgentProfile => {
  const profile = agentProfile("claude");
  if (profile === undefined) throw new Error("no claude profile");
  return profile;
};

const lists = (terminal: boolean) => ({
  allowed: claude().allowlist(SERVED),
  denied: claude().denylist(ROOT, BASE, { terminal }),
});

const terminalArgv = (prompt: string, extra: { command?: string[]; resume?: string } = {}) =>
  claude().workerArgv({
    mechanism: "terminal",
    prompt,
    mcpConfig: "{}",
    ...lists(true),
    ...(extra.resume === undefined ? { sessionId: ID } : { resume: extra.resume }),
    ...(extra.command === undefined ? {} : { command: extra.command }),
  });

/** A `Bash(<glob>)` deny pattern as Claude Code documents it: `*` is any text. */
const refuses = (denied: readonly string[], command: string) =>
  denied
    .filter((d) => d.startsWith("Bash("))
    .some((d) =>
      new RegExp(
        `^${d
          .slice(5, -1)
          .split("*")
          .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
        "s",
      ).test(command),
    );

describe("t45 the profile table", () => {
  test("t45_profiles_are_reached_by_name", () => {
    expect(Object.keys(AGENT_PROFILES)).toEqual(["claude"]);
    expect(agentProfile("claude")?.name).toBe("claude");
    for (const name of ["codex", "opencode", "constructor", "__proto__", ""]) {
      expect(agentProfile(name), name).toBeUndefined();
    }
    // What the spike answered either way, as fields of the entry.
    expect(claude().idleWrites).toBe(false);
    expect(claude().resumeAcrossModes).toBe(true);
    expect(claude().wait).toBe("background");
    // One list of flags: the config's grammar and the profile read the same one.
    expect(claude().terminalFlags).toEqual(["--model", "--effort", "--fallback-model"]);
    expect(claude().terminalFlags).toBe(WORKER_ENGINES.claude?.terminalFlags as readonly string[]);
  });

  test("t45_absent_worker_key_is_print_until_the_serve_rule", () => {
    // Step 8 of TASK-EKAV turns the default; until then only an explicit `terminal` starts one.
    expect(DEFAULT_WORKER_MECHANISM).toBe("print");
    expect(workerMechanismOf(undefined)).toBe("print");
    expect(workerMechanismOf({})).toBe("print");
    expect(workerMechanismOf({ worker: "terminal" })).toBe("terminal");
    expect(workerMechanismOf({ worker: "print" })).toBe("print");
  });

  test("t45_profile_prompt_cannot_name_a_subcommand", () => {
    // A bare `doctor` or `mcp` is run by claude as its subcommand, also after `--`; with a newline at its
    // end it is a prompt (spikes/ekav-m0/NOTE.md, criterion 3).
    for (const prompt of ["doctor", "mcp", "Kodel run r_0abc_0000 exists and is yours to drive."]) {
      const argv = terminalArgv(prompt);
      expect(argv.slice(-2), prompt).toEqual(["--", `${prompt}\n`]);
      expect(argv.indexOf("--"), prompt).toBe(argv.length - 2);
      expect(
        argv.filter((a) => a === prompt),
        prompt,
      ).toEqual([]);
    }
    // A prompt that already ends with one gets no second.
    expect(terminalArgv("doctor\n").at(-1)).toBe("doctor\n");
    // The same rule for a session a person starts for themselves.
    expect(claude().sessionArgv({ prompt: "doctor", sessionId: ID })).toEqual([
      "claude",
      "--session-id",
      ID,
      "--",
      "doctor\n",
    ]);
    expect(claude().sessionArgv({ resume: ID })).toEqual(["claude", "--resume", ID]);
  });

  test("t45_claude_terminal_argv", () => {
    const { allowed, denied } = lists(true);
    const argv = terminalArgv("go on");
    // The prompt is last, after `--` (step 4 as the spike changed it), and nothing makes it a print run.
    expect(argv).toEqual([
      "claude",
      "--session-id",
      ID,
      "--mcp-config",
      "{}",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      allowed.join(","),
      "--disallowedTools",
      denied.join(","),
      "--",
      "go on\n",
    ]);
    for (const flag of ["-p", "--print", "--output-format", "--verbose"]) {
      expect(argv, flag).not.toContain(flag);
    }
    const resumed = terminalArgv("go on", { resume: ID });
    expect(resumed.slice(1, 3)).toEqual(["--resume", ID]);
    expect(resumed).not.toContain("--session-id");
    // A terminal worker watches its run, so `kodel wait` is not refused to it; a print worker's is.
    expect(denied.some((d) => d.includes("wait r_"))).toBe(false);
    expect(lists(false).denied.some((d) => d.includes("wait r_"))).toBe(true);
  });

  test("t45_worker_print_argv_is_todays", () => {
    const input = { prompt: "go on", mcpConfig: "{}", ...lists(false), sessionId: ID };
    const argv = claude().workerArgv({ mechanism: "print", ...input });
    expect(argv).toEqual(workerArgv(input));
    expect(argv.slice(0, 6)).toEqual([
      "claude",
      "-p",
      "go on",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    // `terminal.command` is the terminal's: a print worker is the profile's own program.
    expect(
      claude().workerArgv({ mechanism: "print", ...input, command: ["wrap", "--model", "x"] }),
    ).toEqual(argv);
  });

  test("t45_engines_terminal_override", () => {
    const argv = terminalArgv("go on", {
      command: ["/opt/bin/claude-wrap", "--model", "opus", "--effort=high"],
    });
    expect(argv[0]).toBe("/opt/bin/claude-wrap");
    // The person's flags as they wrote them, after kodel's own and before the prompt.
    expect(argv.slice(-5)).toEqual(["--model", "opus", "--effort=high", "--", "go on\n"]);
    expect(argv.indexOf("--disallowedTools")).toBe(argv.length - 7);
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(
      claude().workerArgvProblem(argv, { mechanism: "terminal", program: "/opt/bin/claude-wrap" }),
    ).toBeUndefined();
    expect(claude().sessionArgv({ command: ["wrap", "--model", "opus"], sessionId: ID })).toEqual([
      "wrap",
      "--model",
      "opus",
      "--session-id",
      ID,
    ]);
  });

  test("t45_engines_terminal_allows_only_listed_flags", () => {
    const rows: [string[], string][] = [
      [["claude", "--dangerously-skip-permissions"], '"--dangerously-skip-permissions"'],
      [["claude", "--permission-mode", "bypassPermissions"], '"--permission-mode"'],
      [["claude", "--permission-mode=bypassPermissions"], '"--permission-mode"'],
      [["claude", "-m", "opus"], '"-m"'],
      [["claude", "-p"], '"-p"'],
      [["claude", "--mcp-config", "x.json"], '"--mcp-config"'],
      [["claude", "doctor"], '"doctor" is a bare word'],
      [["claude", "--model", "opus", "extra"], '"extra" is a bare word'],
      [["claude", "--model", "--effort"], 'the value of "--model" ("--effort") begins with -'],
      [["claude", "--model=-x"], 'the value of "--model" ("-x") begins with -'],
      [["claude", "--model"], 'the flag "--model" has no value'],
      [["claude", "--model="], 'the flag "--model" has no value'],
      [["--model", "opus"], "is a flag"],
    ];
    for (const [command, said] of rows) {
      let error: unknown;
      try {
        terminalArgv("go on", { command });
      } catch (e) {
        error = e;
      }
      expect(error, command.join(" ")).toBeInstanceOf(Error);
      expect((error as Error).message, command.join(" ")).toContain("terminal.command");
      expect((error as Error).message, command.join(" ")).toContain(said);
      expect(() => claude().sessionArgv({ command, prompt: "x" })).toThrow("terminal.command");
    }
    for (const flag of claude().terminalFlags) {
      expect(terminalArgv("go on", { command: ["claude", flag, "v"] })).toContain(flag);
      expect(terminalArgv("go on", { command: ["claude", `${flag}=v`] })).toContain(`${flag}=v`);
    }
  });

  test("t45_final_argv_is_checked", () => {
    const terminal = { mechanism: "terminal", program: "claude" } as const;
    const print = { mechanism: "print", program: "claude" } as const;
    const good = terminalArgv("go on", { command: ["claude", "--model", "opus", "--effort=high"] });
    expect(claude().workerArgvProblem(good, terminal)).toBeUndefined();
    expect(claude().workerArgvProblem(terminalArgv("x", { resume: ID }), terminal)).toBeUndefined();
    const printed = claude().workerArgv({
      mechanism: "print",
      prompt: "--dangerously-skip-permissions",
      mcpConfig: "{}",
      ...lists(false),
      resume: ID,
    });
    expect(claude().workerArgvProblem(printed, print)).toBeUndefined();

    const before = (argv: string[], flag: string, ...added: string[]) => {
      const at = argv.indexOf(flag);
      return [...argv.slice(0, at), ...added, ...argv.slice(at)];
    };
    const without = (argv: string[], flag: string, values: number) => {
      const at = argv.indexOf(flag);
      return [...argv.slice(0, at), ...argv.slice(at + 1 + values)];
    };
    const swapped = (argv: string[], flag: string, value: string) => {
      const out = [...argv];
      out[argv.indexOf(flag) + 1] = value;
      return out;
    };
    const rows: [string, string[], typeof terminal | typeof print, string][] = [
      ["another program", ["sh", ...good.slice(1)], terminal, "is not the program claude"],
      [
        "a flag nobody allowed",
        before(good, "--", "--dangerously-skip-permissions"),
        terminal,
        '("--dangerously-skip-permissions") is not the program',
      ],
      ["a short form", before(good, "--", "-m", "opus"), terminal, '("-m") is not the program'],
      ["a bare word", before(good, "--", "doctor"), terminal, '("doctor") is not the program'],
      [
        "an allowed flag with a flag as its value",
        before(good, "--", "--model", "--add-dir"),
        terminal,
        '("--model") is not the program',
      ],
      [
        "another permission mode",
        swapped(good, "--permission-mode", "bypassPermissions"),
        terminal,
        "is not a value kodel gives --permission-mode",
      ],
      [
        "a second permission mode",
        before(good, "--", "--permission-mode", "dontAsk"),
        terminal,
        "is there twice",
      ],
      ["an id that is none", swapped(good, "--session-id", "x"), terminal, "--session-id"],
      ["no strict config", without(good, "--strict-mcp-config", 0), terminal, "is missing"],
      ["no deny list", without(good, "--disallowedTools", 1), terminal, "is missing"],
      ["no permission mode", without(good, "--permission-mode", 1), terminal, "is missing"],
      ["no server", without(good, "--mcp-config", 1), terminal, "is missing"],
      ["two elements after --", [...good, "more\n"], terminal, "exactly one element"],
      ["no prompt", good.slice(0, -2), terminal, "the prompt is missing"],
      [
        "a prompt that names a subcommand",
        [...good.slice(0, -1), "doctor"],
        terminal,
        "does not end with a newline",
      ],
      ["a print flag in a terminal", before(good, "--", "--verbose"), terminal, "print worker"],
      ["a terminal argv for print", good, print, "is not the program, an element"],
      ["a person's flag on a print worker", [...printed, "--model", "opus"], print, '("--model")'],
      ["both ids", before(good, "--", "--resume", ID), terminal, "both --session-id and --resume"],
    ];
    for (const [name, argv, expected, said] of rows) {
      const problem = claude().workerArgvProblem(argv, expected);
      expect(problem, name).toBeDefined();
      expect(problem, name).toContain(said);
    }
  });

  test("t45_step_command_is_not_the_workers_program", async () => {
    // The profile named `claude` may also be a step profile; its step `command` is the engine step's.
    const settings = {
      command: ["/opt/steps/reviewer", "-p", "--output-format", "json"],
      worker: "terminal" as const,
    };
    expect(workerProgramOf(claude(), settings, "terminal")).toBe("claude");
    expect(workerProgramOf(claude(), settings, "print")).toBe("claude");
    expect(workerProgramOf(claude(), undefined, "terminal")).toBe("claude");
    const wrapped = { ...settings, terminal: { command: ["/opt/bin/wrap", "--model", "opus"] } };
    expect(workerProgramOf(claude(), wrapped, "terminal")).toBe("/opt/bin/wrap");
    // `terminal.command` is the terminal's alone.
    expect(workerProgramOf(claude(), wrapped, "print")).toBe("claude");
    for (const mechanism of ["terminal", "print"] as const) {
      const argv = claude().workerArgv({
        mechanism,
        prompt: "go on",
        mcpConfig: "{}",
        ...lists(mechanism === "terminal"),
        sessionId: ID,
      });
      expect(argv[0]).toBe("claude");
      expect(argv.join(" ")).not.toContain("/opt/steps/reviewer");
    }
    // An engine step of the same profile still runs the step command.
    const step = await configEngineResolver(
      async () => ({ claude: settings }),
      () => ({ PATH: "/usr/bin" }),
    ).resolve({ profile: "claude", prompt: "review" }, { cwd: "/w" });
    expect(step.ok).toBe(true);
    if (step.ok) {
      expect(step.launch.argv).toEqual([
        "/opt/steps/reviewer",
        "-p",
        "--output-format",
        "json",
        "--",
        "review",
      ]);
    }
  });
});

describe("t45 the lists of a worker", () => {
  test("t45_worker_lists_refuse_decisions", () => {
    for (const terminal of [true, false]) {
      const { allowed, denied } = lists(terminal);
      for (const tool of WORKER_DENIED) {
        expect(allowed).not.toContain(tool);
        expect(denied).toContain(tool);
      }
      // Also when the served list is handed in with the decision tools in it.
      const served = [...SERVED, "pipeline_decide_gate", "pipeline_accept_change"];
      expect(
        claude()
          .allowlist(served)
          .filter((t) => /decide|accept/.test(t)),
      ).toEqual([]);
    }
  });

  test("t45_deny_list_refuses_no_honest_command", () => {
    for (const terminal of [true, false]) {
      const { allowed, denied } = lists(terminal);
      for (const tool of allowed) expect(denied, tool).not.toContain(tool);
      for (const command of [
        "git commit -m 'fix mcp'",
        "cd /proj/.kodel/worktrees/r_0abc_0000 && git commit -s -m 'fix mcp'",
        "cd /proj/.kodel/worktrees/r_0abc_0000 && bun test; wait",
        "bun packages/cli/src/main.ts agent ls --json",
        "bun packages/cli/src/main.ts status",
        "gh pr create --draft --base main",
      ]) {
        expect(refuses(denied, command), command).toBe(false);
      }
      // No pattern is written against the kodel tools: only the two decision tools are named.
      expect(denied.filter((d) => d.includes("mcp__kodel__"))).toEqual([...WORKER_DENIED]);
      for (const command of ["kodel gate r_0abc_0000 approve", "env X=1 kodel gate r_0abc_0000"]) {
        expect(refuses(denied, command), command).toBe(true);
      }
    }
    expect(refuses(lists(false).denied, "kodel wait r_0abc_0000")).toBe(true);
    expect(refuses(lists(true).denied, "kodel wait r_0abc_0000 --timeout 604800")).toBe(false);
  });

  test("t45_every_denied_path_has_an_edit_rule", () => {
    // claude 2.1.330 reports a `Write(<path>)` deny rule as one that never matches and asks for
    // `Edit(<path>)`: the `Edit` rules are the ones that hold, so every path has one, in both spellings.
    for (const terminal of [true, false]) {
      const { denied } = lists(terminal);
      const paths = (tool: string) =>
        denied.filter((d) => d.startsWith(`${tool}(`)).map((d) => d.slice(tool.length + 1, -1));
      const edits = new Set(paths("Edit"));
      expect(paths("Write").length).toBeGreaterThan(0);
      for (const path of paths("Write")) expect(edits.has(path), path).toBe(true);
      for (const path of WORKER_DENIED_PATHS) {
        expect(edits.has(path), path).toBe(true);
        expect(edits.has(`//proj/${path}`), path).toBe(true);
      }
      // The state base outside the root, whole.
      expect(edits.has("//home/u/.kodel/**")).toBe(true);
    }
  });
});
