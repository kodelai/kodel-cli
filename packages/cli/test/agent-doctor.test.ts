/**
 * `kodel agent doctor` (T-47): one test per check, and what holds for all of them: it only reads, it
 * prints kodel's own words (a mark a check, and what to do) and nothing a probe printed, it is the agent's to run, and
 * it exits 1 only when a worker cannot start.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnginesAgainstHead } from "@kodel-ai/local";
import type {
  AgentContext,
  AgentHost,
  AgentProject,
  AgentProjectConfig,
} from "../src/agent-commands";
import { AGENT_HUMAN_COMMANDS, AGENT_READ_COMMANDS } from "../src/agent-commands";
import { DOCTOR_MARKS, doctorColour, runAgentDoctor } from "../src/agent-doctor";
import type { Exec } from "../src/claude-worker";
import { runCli } from "../src/cli";
import { HUMAN_ONLY_COMMANDS } from "../src/human-only";
import type { PreflightInput, PreflightResult } from "../src/worker-launcher";
import { FakeLauncher } from "./fake-launcher";

const WORKTREES = "/proj/.kodel/worktrees";
const ACCOUNT = "person@example.com";
const TRUSTED = JSON.stringify({ projects: { "/proj": { hasTrustDialogAccepted: true } } });

class Refused extends Error {}

interface Setup {
  platform?: string;
  pty?: { ok: true } | { ok: false; reason: string };
  /** Where `claude` is; absent: not on PATH. */
  claude?: string | undefined;
  version?: string | Error;
  auth?: string | Error;
  claudeJson?: string | undefined;
  config?: AgentProjectConfig | Error;
  engines?: EnginesAgainstHead | Error;
  /** The launcher's answers: for a start by a person, then for one nobody watches. */
  preflight?: (input: PreflightInput) => PreflightResult;
  pipelines?: number;
  /** Whether the output is a terminal, and the environment besides `HOME` and `PATH`. */
  terminal?: boolean;
  env?: Record<string, string>;
}

const MARKS: Record<string, "yes" | "no" | "unknown"> = { "✓": "yes", "✗": "no", "?": "unknown" };
const CHECK_LINE = /^( *)([✓✗?]) (.*?)(?: {2,}(.*))?$/;

async function doctor(setup: Setup = {}) {
  let out = "";
  const execs: string[][] = [];
  const lookups: string[] = [];
  const reads: string[] = [];
  const preflights: PreflightInput[] = [];
  const exec: Exec = async (file, args) => {
    execs.push([file, ...args]);
    const answer =
      args[0] === "--version" ? (setup.version ?? "2.1.330 (Claude Code)") : setup.auth;
    if (answer instanceof Error) throw answer;
    return {
      stdout:
        answer ??
        `${JSON.stringify({ loggedIn: true, authMethod: "oauth", email: ACCOUNT, orgName: "Acme" })}\n`,
      stderr: "",
      code: 0,
    };
  };
  const ctx: AgentContext = {
    cwd: "/proj",
    out: (text) => {
      out += text;
    },
    environment: { HOME: "/home/u", PATH: "/usr/bin", ...setup.env },
    ...(setup.terminal ? { outIsTerminal: true } : {}),
    root: async () => "/proj",
    fail: (message: string): never => {
      throw new Refused(message);
    },
    requireHuman() {
      throw new Refused("doctor asked for a person");
    },
    mustConfirm: async () => {
      throw new Refused("doctor asked a question");
    },
    platform: setup.platform ?? "darwin",
    ptyProbe: () => setup.pty ?? { ok: true },
    which: async (name) => {
      lookups.push(name);
      return "claude" in setup ? setup.claude : "/usr/bin/claude";
    },
    exec,
    readText: async (path) => {
      reads.push(path);
      return "claudeJson" in setup ? setup.claudeJson : TRUSTED;
    },
    now: () => 1_000,
  };
  const launcher = new FakeLauncher();
  launcher.preflight = async (input) => {
    preflights.push(input);
    return setup.preflight?.(input) ?? { ok: true };
  };
  const project: AgentProject = {
    root: "/proj",
    version: "test",
    async config() {
      if (setup.config instanceof Error) throw setup.config;
      return setup.config ?? { dialog: false, agentDecides: [], worktreesDir: WORKTREES };
    },
    async engines() {
      if (setup.engines instanceof Error) throw setup.engines;
      return setup.engines ?? { state: "committed", engines: {} };
    },
    launcher: async () => launcher,
    host: async () =>
      ({
        list: async () => ({
          pipelines: Array.from({ length: setup.pipelines ?? 1 }, (_, i) => ({ name: `p${i}` })),
        }),
      }) as unknown as AgentHost,
  };
  const ok = await runAgentDoctor({ ctx, project });
  const lines = out.split("\n").filter((line) => line !== "");
  /** The checks as printed: the mark, the name, what was found, and the line that says what to do. */
  const checks = lines.flatMap((line, at) => {
    const m = CHECK_LINE.exec(line);
    if (!m) return [];
    const next = lines[at + 1] ?? "";
    const under = lines.slice(at + 1).findIndex((l) => CHECK_LINE.test(l));
    const own = lines.slice(at + 1, under === -1 ? undefined : at + 1 + under);
    const fix = own.find((l) => /^ +→ /.test(l))?.replace(/^ +→ /, "");
    return [
      {
        indent: (m[1] as string).length,
        answer: MARKS[m[2] as string] as "yes" | "no" | "unknown",
        check: m[3] as string,
        value: m[4],
        fix,
        next,
      },
    ];
  });
  const row = (check: string) => checks.find((c) => c.check === check);
  /** The answer of a check and what was found, as one string: `no (the reason)`. */
  const answer = (check: string) => {
    const found = row(check);
    if (found === undefined) return undefined;
    return found.value === undefined ? found.answer : `${found.answer} (${found.value})`;
  };
  const fix = (check: string) => row(check)?.fix;
  return { ok, out, lines, checks, row, answer, fix, execs, lookups, reads, preflights };
}

describe("t47 kodel agent doctor: the seven checks", () => {
  test("t47_doctor_platform", async () => {
    expect((await doctor()).answer("platform supported")).toBe("yes (darwin)");
    expect((await doctor({ platform: "linux" })).answer("platform supported")).toBe("yes (linux)");
    const windows = await doctor({
      platform: "win32",
      preflight: () => ({ ok: false, reason: "agents are not supported on Windows yet" }),
    });
    expect(windows.answer("platform supported")).toBe("no (win32)");
    expect(windows.ok).toBe(false);
  });

  test("t47_doctor_terminal_can_run", async () => {
    expect((await doctor()).answer("a terminal session can run")).toBe("yes");
    const reason = "a terminal session cannot run under Bun: use the built kodel on Node";
    const none = await doctor({ pty: { ok: false, reason } });
    expect(none.answer("a terminal session can run")).toBe(`no (${reason})`);
    expect(none.fix("a terminal session can run")).toContain("engines.claude.worker: print");
    // The check says what it found; whether a worker can start is the verdict's (a print worker can).
    expect(none.ok).toBe(true);
  });

  test("t47_doctor_claude_found_version_signed_in", async () => {
    const found = await doctor();
    expect(found.answer("claude found")).toBe("yes (/usr/bin/claude)");
    expect(found.answer("claude version")).toBe("yes (2.1.330)");
    expect(found.answer("claude signed in")).toBe("yes");
    expect(found.execs).toEqual([
      ["claude", "--version"],
      ["claude", "auth", "status", "--json"],
    ]);
    const missing = await doctor({ claude: undefined });
    expect(missing.answer("claude found")).toBe("no (claude is not on PATH)");
    expect(missing.fix("claude found")).toBe("install claude and make sure it is on PATH");
    // Nothing is run for a program that is not there.
    expect(missing.execs).toEqual([]);
    expect(missing.answer("claude version")).toBeUndefined();
    const out = await doctor({ auth: `${JSON.stringify({ loggedIn: false })}\n` });
    expect(out.answer("claude signed in")).toBe("no");
    expect(out.fix("claude signed in")).toBe("run claude auth login");
    for (const auth of ["not json", new Error("spawn failed"), "{}"]) {
      const r = await doctor({ auth });
      expect(r.answer("claude signed in"), String(auth)).toBe("unknown");
      expect(r.fix("claude signed in"), String(auth)).toContain("claude auth status");
    }
    for (const version of ["no number here", new Error("spawn failed")]) {
      const r = await doctor({ version });
      expect(r.answer("claude version"), String(version)).toBe("unknown");
      expect(r.fix("claude version"), String(version)).toContain("claude --version");
    }
    // The program of a terminal worker is `terminal.command[0]`, when the block names one.
    const other = await doctor({
      engines: {
        state: "committed",
        engines: { claude: { terminal: { command: ["/opt/claude-wrapper"] } } },
      },
    });
    expect(other.answer("claude found")).toBe("yes (/opt/claude-wrapper)");
    expect(other.execs[0]).toEqual(["/opt/claude-wrapper", "--version"]);
  });

  test("t47_doctor_never_runs_an_uncommitted_terminal_command", async () => {
    // A worker's shell can write the config; a person who runs doctor must not run what it put there.
    const engines = { claude: { terminal: { command: ["/tmp/planted"] } } };
    const states: EnginesAgainstHead[] = [
      { state: "differs", engines, head: {} },
      { state: "differs", engines },
      { state: "untracked", engines },
      { state: "failed", engines, reason: "git failed" },
    ];
    for (const found of states) {
      const out = await doctor({ engines: found });
      expect(out.answer("claude found"), found.state).toBe("yes (/tmp/planted)");
      expect(out.answer("claude version"), found.state).toBe(
        "unknown (/tmp/planted is not run: engines.claude.terminal.command is not as committed)",
      );
      expect(out.fix("claude version"), found.state).toContain("commit .kodel/config.yaml");
      // Only the profile's own program is run, for the sign-in.
      expect(out.execs, found.state).toEqual([["claude", "auth", "status", "--json"]]);
      expect(out.execs.flat(), found.state).not.toContain("/tmp/planted");
    }
    // A bare name the block gives is looked up and not run either.
    const bare = await doctor({
      engines: { state: "differs", engines: { claude: { terminal: { command: ["planted"] } } } },
    });
    expect(bare.lookups).toContain("planted");
    expect(bare.execs.some((argv) => argv[0] === "planted" || argv[0] === "/usr/bin/planted")).toBe(
      false,
    );
    expect(bare.execs.flat()).not.toContain("planted");
    // With the profile's own program not on PATH nothing at all is run.
    const none = await doctor({ engines: states[0] as EnginesAgainstHead, claude: undefined });
    expect(none.execs).toEqual([]);
    expect(none.answer("claude signed in")).toBe("unknown");
    // A block that differs but names no program leaves the profile's own, which is run as before.
    const own = await doctor({
      engines: { state: "differs", engines: { claude: { worker: "print" } }, head: {} },
    });
    expect(own.execs[0]).toEqual(["claude", "--version"]);
  });

  test("t47_doctor_trust", async () => {
    const trusted = await doctor();
    expect(trusted.answer("worktrees folder trusted")).toBe(`yes (${WORKTREES})`);
    // The folder the worktrees are made in is what is asked about, in claude's own file.
    expect(trusted.reads).toEqual(["/home/u/.claude.json"]);
    const asks = await doctor({
      claudeJson: JSON.stringify({ projects: { "/elsewhere": { hasTrustDialogAccepted: true } } }),
    });
    expect(asks.answer("worktrees folder trusted")).toBe(`no (${WORKTREES})`);
    // Accepting trust is the person's act: the line under it says how, and nothing does it for them.
    expect(asks.fix("worktrees folder trusted")).toBe(
      "start claude in the project root once and accept; kodel never accepts it for you",
    );
    const unknown = await doctor({ claudeJson: undefined });
    expect(unknown.answer("worktrees folder trusted")).toBe(`unknown (${WORKTREES})`);
    expect(unknown.fix("worktrees folder trusted")).toContain("if claude asks");
  });

  test("mstart_doctor_knows_the_manager_keys", async () => {
    const keys = await doctor({
      config: {
        dialog: false,
        agentDecides: ["start_task", "stop_agent"],
        worktreesDir: WORKTREES,
      },
    });
    expect(keys.answer("decisions.agent off")).toContain("no (start_task, stop_agent: ");
    expect(keys.answer("decisions.agent off")).toContain("without `kodel task approve`");
    expect(keys.answer("decisions.agent off")).toContain("a worker never gets them");
    // Only the older keys: the line says nothing of the new tools.
    const gate = await doctor({
      config: { dialog: false, agentDecides: ["gate"], worktreesDir: WORKTREES },
    });
    expect(gate.answer("decisions.agent off")).not.toContain("task approve");
  });

  test("t47_doctor_decisions_dialog_and_agent", async () => {
    const off = await doctor();
    expect(off.answer("decisions.dialog off")).toBe("yes");
    expect(off.answer("decisions.agent off")).toBe("yes");
    const on = await doctor({
      config: { dialog: true, agentDecides: ["gate", "pipeline_change"], worktreesDir: WORKTREES },
      preflight: () => ({ ok: false, reason: "the project asks decisions in a dialog" }),
    });
    expect(on.answer("decisions.dialog off")).toContain("no (a background agent cannot answer");
    expect(on.answer("decisions.agent off")).toContain("no (gate, pipeline_change: ");
    expect(on.answer("decisions.agent off")).toContain("a worker's own server never decides");
    expect(on.answer("decisions.agent off")).toContain("the project's server is a worker too");
    expect(on.answer("decisions.agent off")).not.toContain("which may");
    expect(on.fix("decisions.dialog off")).toContain("set decisions.dialog: false");
    expect(on.fix("decisions.agent off")).toContain("nothing stops a worker");
    // The launcher is asked with what the config says.
    expect(on.preflights[0]?.dialog).toBe(true);
    expect(on.ok).toBe(false);
    const broken = await doctor({ config: new Error("config.yaml: unknown key: serv") });
    expect(broken.answer("decisions.dialog off")).toBe("unknown (config.yaml: unknown key: serv)");
    expect(broken.answer("a worker cannot start")).toBe("no (config.yaml: unknown key: serv)");
    expect(broken.fix("decisions.dialog off")).toContain(".kodel/config.yaml");
    expect(broken.ok).toBe(false);
  });

  test("t47_doctor_engines_block_and_head", async () => {
    expect((await doctor()).answer("engines block as committed")).toBe("yes (worker: terminal)");
    const print = await doctor({
      engines: { state: "committed", engines: { claude: { worker: "print" } } },
    });
    expect(print.answer("engines block as committed")).toBe("yes (worker: print)");
    const differs = await doctor({
      engines: { state: "differs", head: {}, engines: { claude: { worker: "print" } } },
    });
    expect(differs.answer("engines block as committed")).toContain("no (");
    expect(differs.out).toContain('engines.claude.worker: committed absent, now "print"');
    // What differs is under its check, before the line that says what to do.
    const at = differs.lines.findIndex((l) => l.includes("engines block as committed"));
    expect(differs.lines[at + 1]).toMatch(/^ {6}\S.*committed absent, now "print"$/);
    expect(differs.lines[at + 2]).toMatch(/^ {6}→ commit \.kodel\/config\.yaml/);
    const untracked = await doctor({ engines: { state: "untracked", engines: {} } });
    expect(untracked.answer("engines block as committed")).toContain(
      "unknown (git does not track .kodel/config.yaml",
    );
    expect(untracked.fix("engines block as committed")).toContain("commit .kodel/config.yaml");
    for (const engines of [
      { state: "failed", reason: "fatal: detected dubious ownership", engines: {} } as const,
      new Error("fatal: detected dubious ownership"),
    ]) {
      expect((await doctor({ engines })).answer("engines block as committed")).toBe(
        "unknown (fatal: detected dubious ownership)",
      );
    }
    // A value of `env` is never printed.
    const secret = await doctor({
      engines: {
        state: "differs",
        head: {},
        engines: { other: { command: ["x"], env: { TOKEN: "s3cr3t-value" } } },
      },
    });
    expect(secret.out).not.toContain("s3cr3t-value");
  });

  test("t47_doctor_worker_can_start", async () => {
    const yes = await doctor();
    expect(yes.ok).toBe(true);
    expect(yes.answer("a worker can start")).toBe("yes");
    expect(yes.lines.at(-1)).toBe("✓ a worker can start");
    // The verdict is the launcher's own preflight, for a run with no task: by a person, then unattended.
    expect(yes.preflights).toEqual([
      { dialog: false, taskLink: false, noTask: true, pipelines: 1, worktreesDir: WORKTREES },
      {
        dialog: false,
        taskLink: false,
        noTask: true,
        pipelines: 1,
        worktreesDir: WORKTREES,
        unattended: true,
      },
    ]);
    const no = await doctor({
      preflight: () => ({ ok: false, reason: "claude was not found on PATH" }),
    });
    expect(no.ok).toBe(false);
    expect(no.answer("a worker cannot start")).toBe("no (claude was not found on PATH)");
    expect(no.answer("a worker can start")).toBeUndefined();
    expect(no.preflights.length).toBe(1);
    // A start a person watches goes on, one nobody watches does not: yes, with the daemon's reason.
    const daemonOnly = await doctor({
      preflight: (input) =>
        input.unattended === true
          ? { ok: false, reason: "claude will first ask whether the folder is trusted" }
          : { ok: true, note: "open the agent and answer it" },
    });
    expect(daemonOnly.ok).toBe(true);
    expect(daemonOnly.answer("a worker can start")).toBe("yes");
    expect(daemonOnly.answer("kodel serve cannot start one")).toBe(
      "no (claude will first ask whether the folder is trusted)",
    );
    // Every line is a check and its answer, in the order of the seven.
    expect(yes.checks.length).toBe(yes.lines.length);
    expect(yes.checks.map((c) => c.check)).toEqual([
      "platform supported",
      "a terminal session can run",
      "claude found",
      "claude version",
      "claude signed in",
      "worktrees folder trusted",
      "decisions.dialog off",
      "decisions.agent off",
      "engines block as committed",
      "a worker can start",
    ]);
    for (const c of yes.checks) expect(c.answer, c.check).toBe("yes");
  });
});

describe("t47 kodel agent doctor: how the report reads", () => {
  const broken = () =>
    doctor({
      claude: "/usr/bin/claude",
      auth: `${JSON.stringify({ loggedIn: false })}\n`,
      claudeJson: undefined,
      pty: { ok: false, reason: "no terminal module" },
      config: { dialog: true, agentDecides: ["gate"], worktreesDir: WORKTREES },
      engines: { state: "differs", head: {}, engines: { claude: { worker: "print" } } },
      preflight: () => ({ ok: false, reason: "the project asks decisions in a dialog" }),
    });

  test("t47_doctor_marks_every_check_and_says_what_to_do", async () => {
    const r = await broken();
    // One mark a check: what holds, what does not, what cannot be told.
    expect(r.checks.map((c) => `${DOCTOR_MARKS[c.answer]} ${c.check}`)).toEqual([
      "✓ platform supported",
      "✗ a terminal session can run",
      "✓ claude found",
      "✓ claude version",
      "✗ claude signed in",
      "? worktrees folder trusted",
      "✗ decisions.dialog off",
      "✗ decisions.agent off",
      "✗ engines block as committed",
      "✗ a worker cannot start",
    ]);
    // Under every check that does not hold, or cannot be told, an indented line says what to do;
    // under one that holds there is none.
    for (const c of r.checks) {
      if (c.answer === "yes") expect(c.fix, c.check).toBeUndefined();
      else expect(c.fix?.length, c.check).toBeGreaterThan(10);
    }
    expect(r.lines.filter((l) => /^ +→ /.test(l)).length).toBe(7);
    // The fix is deeper than its check, and every line of the report is one of the three kinds.
    for (const line of r.out.split("\n")) {
      expect(line, line).toMatch(/^(|( {2})?[✓✗?] \S.*| {4,6}\S.*)$/);
    }
    // A healthy report has no such line and no mark but the first.
    const fine = await doctor();
    expect(fine.out).not.toContain("→");
    expect(fine.out).not.toMatch(/[✗?]/);
  });

  test("t47_doctor_verdict_stands_apart", async () => {
    for (const r of [await doctor(), await broken()]) {
      const all = r.out.split("\n");
      const at = all.findIndex((l) => /^[✓✗] a worker can/.test(l));
      // An empty line before it, no indent on it; the checks above are indented.
      expect(at).toBeGreaterThan(0);
      expect(all[at - 1]).toBe("");
      expect(all.filter((l) => l === "").length).toBe(2); // that one, and the end of the output
      const verdict = r.checks.at(-1);
      expect(verdict?.indent).toBe(0);
      for (const c of r.checks.slice(0, -1)) expect(c.indent, c.check).toBe(2);
    }
    const daemonOnly = await doctor({
      preflight: (input) =>
        input.unattended === true
          ? { ok: false, reason: "nobody is there to answer" }
          : { ok: true },
    });
    expect(daemonOnly.lines.slice(-3)).toEqual([
      "✓ a worker can start",
      "✗ kodel serve cannot start one  nobody is there to answer",
      "    → kodel agent start and s in the TUI still can; see the lines marked ✗ and ? above",
    ]);
  });

  test("t47_doctor_colours_only_a_terminal_without_no_color", async () => {
    const ESC = String.fromCharCode(27);
    const plainOut = (await broken()).out;
    expect(plainOut).not.toContain(ESC);
    // Not a terminal, or NO_COLOR set: not one escape, whatever else holds.
    for (const setup of [
      { terminal: false },
      { terminal: true, env: { NO_COLOR: "1" } },
      { terminal: false, env: { NO_COLOR: "1" } },
    ]) {
      expect(doctorColour({ outIsTerminal: setup.terminal, environment: setup.env ?? {} })).toBe(
        false,
      );
    }
    expect(doctorColour({ outIsTerminal: true, environment: {} })).toBe(true);
    // An empty NO_COLOR is not set, as the convention has it.
    expect(doctorColour({ outIsTerminal: true, environment: { NO_COLOR: "" } })).toBe(true);
    const piped = await doctor({ terminal: true, env: { NO_COLOR: "1" } });
    expect(piped.out).not.toContain(ESC);

    const coloured = (
      await doctor({
        terminal: true,
        claude: "/usr/bin/claude",
        auth: `${JSON.stringify({ loggedIn: false })}\n`,
        claudeJson: undefined,
      })
    ).out;
    // Green for what holds, red for what does not, yellow for what cannot be told; the value dimmed.
    expect(coloured).toContain(`${ESC}[32m✓${ESC}[0m platform supported`);
    expect(coloured).toContain(`${ESC}[31m✗${ESC}[0m claude signed in`);
    expect(coloured).toContain(`${ESC}[33m?${ESC}[0m worktrees folder trusted`);
    expect(coloured).toContain(`${ESC}[2m/usr/bin/claude${ESC}[0m`);
    // The same words with the colour taken out.
    const stripped = coloured.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
    const same = await doctor({
      claude: "/usr/bin/claude",
      auth: `${JSON.stringify({ loggedIn: false })}\n`,
      claudeJson: undefined,
    });
    expect(stripped).toBe(same.out);
  });

  test("t47_doctor_value_cannot_fake_a_line_or_a_colour", async () => {
    const ESC = String.fromCharCode(27);
    const r = await doctor({
      terminal: true,
      pty: { ok: false, reason: `bad${ESC}[32m\n  ✓ a worker can start` },
      preflight: () => ({ ok: false, reason: "no" }),
    });
    const line = r.out.split("\n").find((l) => l.includes("a terminal session can run")) ?? "";
    expect(line).toContain("bad");
    expect(line).toContain("a worker can start");
    expect(line.split(ESC).length).toBe(5); // the mark's two and the value's two, none of the reason's
  });
});

describe("t47 kodel agent doctor: what holds for every check", () => {
  test("t47_doctor_malformed_engine_files_are_unknown", async () => {
    for (const claudeJson of [
      "{ not json",
      "[]",
      "null",
      JSON.stringify({ projects: "none" }),
      JSON.stringify({ somethingElse: true }),
      "",
    ]) {
      const r = await doctor({ claudeJson });
      expect(r.answer("worktrees folder trusted"), claudeJson).toBe(`unknown (${WORKTREES})`);
      // A file of another product that cannot be read is no reason to refuse.
      expect(r.ok, claudeJson).toBe(true);
    }
  });

  test("t47_doctor_prints_no_account_data", async () => {
    const r = await doctor({ version: `2.1.330 (Claude Code) ${ACCOUNT}` });
    expect(r.answer("claude signed in")).toBe("yes");
    expect(r.out).not.toContain(ACCOUNT);
    expect(r.out).not.toContain("Acme");
    expect(r.out).not.toContain("oauth");
    expect(r.out).not.toContain("Claude Code");
    // What a failing probe printed is not shown either.
    const failing = await doctor({ auth: `error: token for ${ACCOUNT} expired\n` });
    expect(failing.answer("claude signed in")).toBe("unknown");
    expect(failing.out).not.toContain(ACCOUNT);
  });
});

describe("t47 kodel agent doctor through the command", () => {
  let dir: string;
  let state: string;
  let home: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kodel-doctor-"));
    state = mkdtempSync(join(tmpdir(), "kodel-doctor-state-"));
    home = mkdtempSync(join(tmpdir(), "kodel-doctor-home-"));
    mkdirSync(join(dir, ".kodel", "pipelines"), { recursive: true });
    // `worker: print`: under `bun test` no terminal runs, and the verdict should get past that.
    writeFileSync(
      join(dir, ".kodel", "config.yaml"),
      "tasks:\n  enabled: true\nengines:\n  claude:\n    worker: print\n",
    );
    writeFileSync(
      join(dir, ".kodel", "pipelines", "one.yaml"),
      "name: one\nnodes:\n  - slug: write\n    kind: agent\n    prompt: write it\nedges: []\n",
    );
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), "{ this is not json");
    writeFileSync(join(home, ".claude", "settings.json"), '{"theme":"dark"}');
  });
  afterEach(() => {
    for (const d of [dir, state, home]) rmSync(d, { recursive: true, force: true });
  });

  /** Every file under the folders, with its bytes and the time it was last written. */
  const snapshot = () =>
    [dir, state, home].flatMap((root) =>
      (readdirSync(root, { recursive: true }) as string[]).sort().map((file) => {
        const path = join(root, file);
        const info = statSync(path);
        return info.isDirectory()
          ? `${path}/`
          : `${path} ${info.mtimeMs} ${readFileSync(path).toString("base64")}`;
      }),
    );

  async function cli(over: { engine?: boolean; interactive?: boolean; launcher?: FakeLauncher }) {
    let out = "";
    let err = "";
    let asked = 0;
    const code = await runCli(["--root", dir, "agent", "doctor"], {
      cwd: dir,
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
      interactive: over.interactive ?? false,
      // An empty PATH: the machine's own `claude` is never run by a test.
      environment: {
        KODEL_STATE_DIR: state,
        HOME: home,
        PATH: join(home, "no-such-bin"),
        ...(over.engine ? { KODEL_ENGINE: "1" } : {}),
      },
      confirm: async () => {
        asked += 1;
        return true;
      },
      select: async () => [],
      platform: "linux",
      ptyProbe: () => ({ ok: true }),
      insideSession: () => "inside",
      ...(over.launcher === undefined
        ? {}
        : {
            agent: {
              launcher: async () => over.launcher as FakeLauncher,
              which: async (name: string) => `/usr/bin/${name}`,
              exec: async () => ({ stdout: `{"loggedIn":true}\n1.2.3\n`, stderr: "", code: 0 }),
            },
          }),
    });
    return { code, out, err, asked };
  }

  test("t47_doctor_writes_nothing", async () => {
    const before = snapshot();
    const r = await cli({});
    // `claude` is not on this PATH: no worker can start, and that is the one reason for exit 1.
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ {2}✗ claude found {2,}claude is not on PATH\n/);
    expect(r.out).toMatch(/\n\n✗ a worker cannot start {2,}claude was not found on PATH\n/);
    // A pipe, not a terminal: no colour.
    expect(r.out).not.toContain(String.fromCharCode(27));
    expect(r.err).toContain("a worker cannot start here");
    // claude's own file does not parse: unknown, never a refusal of its own.
    expect(r.out).toMatch(/ {2}\? worktrees folder trusted/);
    expect(r.asked).toBe(0);
    // Its own files, the state base and claude's files: byte for byte what they were.
    expect(snapshot()).toEqual(before);
    expect(readdirSync(state)).toEqual([]);
    // And when a worker can start, too.
    const ok = await cli({ launcher: new FakeLauncher() });
    expect(ok.code, ok.err).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  test("t47_doctor_runs_for_an_agent", async () => {
    // The engine's mark, no terminal, inside an agent session: every guard of a person's command
    // would refuse here. `doctor` is not one of them.
    const launcher = new FakeLauncher();
    const r = await cli({ engine: true, interactive: false, launcher });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain("\n\n✓ a worker can start\n");
    expect(r.out).not.toContain("for a person");
    expect(r.asked).toBe(0);
    // It asked the launcher, and started nothing.
    expect(launcher.preflights.length).toBe(2);
    expect(launcher.starts).toEqual([]);
    // The walk of the commands lists it as the agent's, and no list of the person's holds it.
    expect(AGENT_READ_COMMANDS).toContain("agent doctor");
    expect(AGENT_HUMAN_COMMANDS as readonly string[]).not.toContain("agent doctor");
    expect(HUMAN_ONLY_COMMANDS).not.toContain("agent doctor");
    const source = readFileSync(join(import.meta.dir, "../src/agent-doctor.ts"), "utf8");
    expect(source).not.toContain("requireHuman");
    expect(source).not.toContain("mustConfirm");
    expect(source).not.toMatch(/writeFile|mkdir|rename|appendFile|rmSync|unlink/);
  });
});
