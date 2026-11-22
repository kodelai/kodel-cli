/**
 * `kodel agent doctor` (T-45): one test per check, and what holds for all of them: it only reads, it
 * prints kodel's own words (yes, no, unknown) and nothing a probe printed, it is the agent's to run, and
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
import { runAgentDoctor } from "../src/agent-doctor";
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
}

async function doctor(setup: Setup = {}) {
  let out = "";
  const execs: string[][] = [];
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
    environment: { HOME: "/home/u", PATH: "/usr/bin" },
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
    which: async () => ("claude" in setup ? setup.claude : "/usr/bin/claude"),
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
  /** The answer of a check: the word after its name. */
  const answer = (check: string) =>
    lines.find((line) => line.startsWith(`${check}: `))?.slice(check.length + 2);
  return { ok, out, lines, answer, execs, reads, preflights };
}

describe("t45 kodel agent doctor: the seven checks", () => {
  test("t45_doctor_platform", async () => {
    expect((await doctor()).answer("platform supported")).toBe("yes (darwin)");
    expect((await doctor({ platform: "linux" })).answer("platform supported")).toBe("yes (linux)");
    const windows = await doctor({
      platform: "win32",
      preflight: () => ({ ok: false, reason: "agents are not supported on Windows yet" }),
    });
    expect(windows.answer("platform supported")).toBe("no (win32)");
    expect(windows.ok).toBe(false);
  });

  test("t45_doctor_terminal_can_run", async () => {
    expect((await doctor()).answer("a terminal session can run")).toBe("yes");
    const reason = "a terminal session cannot run under Bun: use the built kodel on Node";
    const none = await doctor({ pty: { ok: false, reason } });
    expect(none.answer("a terminal session can run")).toBe(`no (${reason})`);
    // The check says what it found; whether a worker can start is the verdict's (a print worker can).
    expect(none.ok).toBe(true);
  });

  test("t45_doctor_claude_found_version_signed_in", async () => {
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
    // Nothing is run for a program that is not there.
    expect(missing.execs).toEqual([]);
    expect(missing.answer("claude version")).toBeUndefined();
    const out = await doctor({ auth: `${JSON.stringify({ loggedIn: false })}\n` });
    expect(out.answer("claude signed in")).toBe("no (run claude auth login)");
    for (const auth of ["not json", new Error("spawn failed"), "{}"]) {
      expect((await doctor({ auth })).answer("claude signed in"), String(auth)).toBe("unknown");
    }
    for (const version of ["no number here", new Error("spawn failed")]) {
      expect((await doctor({ version })).answer("claude version"), String(version)).toBe("unknown");
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

  test("t45_doctor_trust", async () => {
    const trusted = await doctor();
    expect(trusted.answer("worktrees folder trusted")).toBe(`yes (${WORKTREES})`);
    // The folder the worktrees are made in is what is asked about, in claude's own file.
    expect(trusted.reads).toEqual(["/home/u/.claude.json"]);
    const asks = await doctor({
      claudeJson: JSON.stringify({ projects: { "/elsewhere": { hasTrustDialogAccepted: true } } }),
    });
    expect(asks.answer("worktrees folder trusted")).toContain("no (");
    // Accepting trust is the person's act: the line says how, and nothing does it for them.
    expect(asks.answer("worktrees folder trusted")).toContain(
      "start claude in the project root once and accept; kodel never accepts it for you",
    );
    expect((await doctor({ claudeJson: undefined })).answer("worktrees folder trusted")).toBe(
      `unknown (${WORKTREES})`,
    );
  });

  test("t45_doctor_decisions_dialog_and_agent", async () => {
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
    // The launcher is asked with what the config says.
    expect(on.preflights[0]?.dialog).toBe(true);
    expect(on.ok).toBe(false);
    const broken = await doctor({ config: new Error("config.yaml: unknown key: serv") });
    expect(broken.answer("decisions.dialog off")).toBe("unknown (config.yaml: unknown key: serv)");
    expect(broken.answer("a worker can start")).toBe("no (config.yaml: unknown key: serv)");
    expect(broken.ok).toBe(false);
  });

  test("t45_doctor_engines_block_and_head", async () => {
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
    const untracked = await doctor({ engines: { state: "untracked", engines: {} } });
    expect(untracked.answer("engines block as committed")).toContain(
      "unknown (git does not track .kodel/config.yaml",
    );
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

  test("t45_doctor_worker_can_start", async () => {
    const yes = await doctor();
    expect(yes.ok).toBe(true);
    expect(yes.answer("a worker can start")).toBe("yes");
    expect(yes.lines.at(-1)).toBe("a worker can start: yes");
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
    expect(no.answer("a worker can start")).toBe("no (claude was not found on PATH)");
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
    expect(daemonOnly.answer("kodel serve can start one")).toBe(
      "no (claude will first ask whether the folder is trusted)",
    );
    // Every line is a check and its answer, in the order of the seven.
    expect(yes.lines.map((line) => line.split(": ")[0])).toEqual([
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
    for (const line of yes.lines) expect(line).toMatch(/: (yes|no|unknown)( \(.*\))?$/);
  });
});

describe("t45 kodel agent doctor: what holds for every check", () => {
  test("t45_doctor_malformed_engine_files_are_unknown", async () => {
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

  test("t45_doctor_prints_no_account_data", async () => {
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

describe("t45 kodel agent doctor through the command", () => {
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

  test("t45_doctor_writes_nothing", async () => {
    const before = snapshot();
    const r = await cli({});
    // `claude` is not on this PATH: no worker can start, and that is the one reason for exit 1.
    expect(r.code).toBe(1);
    expect(r.out).toContain("claude found: no (claude is not on PATH)");
    expect(r.out).toContain("a worker can start: no (claude was not found on PATH)");
    expect(r.err).toContain("a worker cannot start here");
    // claude's own file does not parse: unknown, never a refusal of its own.
    expect(r.out).toContain("worktrees folder trusted: unknown");
    expect(r.asked).toBe(0);
    // Its own files, the state base and claude's files: byte for byte what they were.
    expect(snapshot()).toEqual(before);
    expect(readdirSync(state)).toEqual([]);
    // And when a worker can start, too.
    const ok = await cli({ launcher: new FakeLauncher() });
    expect(ok.code, ok.err).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  test("t45_doctor_runs_for_an_agent", async () => {
    // The engine's mark, no terminal, inside an agent session: every guard of a person's command
    // would refuse here. `doctor` is not one of them.
    const launcher = new FakeLauncher();
    const r = await cli({ engine: true, interactive: false, launcher });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain("a worker can start: yes\n");
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
