/**
 * The launcher of background agents (TASK-9PNS): the claude profile (argv, lists, prompts, environment,
 * the session id), the session-backed launcher over the scripted adapter and a fake `exec`, the start
 * through a real `LocalPipelineHost` with the fake launcher, and the real adapter with a Node script
 * standing for `claude` (skipped where the process table cannot be read, required under
 * `KODEL_REQUIRE_PROCTABLE=1`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalPipelineHost,
  type LocalRun,
  loadConfig,
  openTaskService,
  ownProcessGroup,
  PipesSessionAdapter,
  sessionPlace,
  type UnattendedEngines,
} from "@kodel-ai/local";
import { SessionError, type SessionListEntry, validateSpec } from "@kodel-ai/pipeline-core";
import { decisionTools, HISTORY_TOOLS, TOOLS } from "@kodel-ai/pipeline-core/mcp";
import { resumeVerdict, servePlaces } from "@kodel-ai/pipeline-core/serve";
import { ScriptedSessionAdapter } from "../../testkit/src/engine-fakes";
import { AGENT_HUMAN_COMMANDS } from "../src/agent-commands";
import {
  AGENT_PROFILES,
  type AgentProfile,
  agentProfile,
  DEFAULT_WORKER_MECHANISM,
  WORKER_PRINT_MIGRATION_LINE,
} from "../src/agent-profiles";
import {
  authProbe,
  type Exec,
  resumePrompt,
  sessionIdOf,
  shellQuote,
  terminalWorkerArgv,
  trustProbe,
  WORKER_DENIED,
  WORKER_TOOLS,
  waitCommandProblem,
  workerAllowlist,
  workerDenylist,
  workerEnv,
  workerMcpConfig,
  workerPrompt,
  workerWaitCommand,
} from "../src/claude-worker";
import { type CliEnv, runCli } from "../src/cli";
import { loadSessions } from "../src/tui/load";
import { openTasksForTui } from "../src/tui/tasks-open";
import { initialModel, withWorkers } from "../src/tui/view";
import { decisionOf, resumeOffer } from "../src/tui/worker-resume";
import { createWorkerOptions, taskTextOf } from "../src/tui/worker-start";
import { serveLauncherOf, serveWorkerOf } from "../src/worker-factory";
import {
  type StartInput,
  WORKER_TERMINAL_TIMEOUT_MS,
  WORKER_TIMEOUT_MS,
  type WorkerDecision,
  type WorkerLauncher,
  workerNameOf,
} from "../src/worker-launcher";
import {
  createSessionWorkerLauncher,
  parseEntry,
  type SessionLauncherDeps,
  startedOf,
  workerStatusOf,
} from "../src/worker-launcher-session";
import { FakeLauncher } from "./fake-launcher";

const UUID = "7f3b2a9c-1d4e-4f6a-9b8c-0d1e2f3a4b5c";
const OTHER = "11111111-2222-4333-8444-555555555555";
const RUN = "r_0mw53d7fj_o2lc";
const ROOT = "/proj";
const BASE = "/home/u/.kodel";

const DECISION: WorkerDecision = {
  seq: 17,
  ts: 5_000,
  kind: "gate",
  node: "plan-approval",
  outcome: "approved",
};

const ENV: Record<string, string | undefined> = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/u",
  CLAUDE_CONFIG_DIR: "/home/u/.claude",
  ANTHROPIC_API_KEY: "sk-ant-test",
  KODEL_STATE_DIR: "/home/u/state",
  KODEL_ENGINE: "1",
  CLAUDECODE: "1",
  CLAUDE_CODE_SESSION_ID: "abc",
  CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
  TMUX: "/tmp/tmux-1/default,1,0",
  "BAD-KEY": "x",
  EMPTY: undefined,
};

const SERVED = [...TOOLS.map((t) => t.name), ...HISTORY_TOOLS.map((t) => t.name)];

/** The `exec` of the launcher over the scripted adapter: `agent ls --json` and `agent logs` from the fake's sessions. */
function fakeExec(
  adapter: ScriptedSessionAdapter,
  probe: { stdout?: string; throws?: boolean; late?: boolean; noAgent?: boolean } = {},
  calls: string[][] = [],
): Exec {
  return async (file, args, options) => {
    calls.push([file, ...args]);
    if (file === "claude") {
      if (probe.throws) throw new Error("spawn failed");
      return {
        stdout: probe.stdout ?? `{"loggedIn":true,"authMethod":"oauth"}\n`,
        stderr: "",
        code: 0,
      };
    }
    const at = args.indexOf("agent");
    const verb = args[at + 1];
    if (verb === "ls") {
      const rows: SessionListEntry[] = [...adapter.sessions.values()].map((s) => ({
        id: s.id,
        ...(s.name === undefined ? {} : { name: s.name }),
        command: (s.spec.argv ?? []).join(" "),
        status: { ...s.status },
        mode: s.spec.mode ?? "pipes",
        ...(s.spec.agent === undefined || probe.noAgent === true
          ? {}
          : { agent: { ...s.spec.agent, source: "chosen" as const } }),
      }));
      return { stdout: JSON.stringify(rows, null, 2), stderr: "", code: 0 };
    }
    if (verb === "logs") {
      const id = args[at + 2] ?? "";
      const bytes = Number(args[args.indexOf("--bytes") + 1]);
      const tail = await adapter.tail(id, bytes);
      return {
        stdout: `${tail.text}${tail.complete ? "" : "\n[earlier output omitted]\n"}`,
        stderr: "",
        code: 0,
      };
    }
    void options;
    return { stdout: "", stderr: `unknown ${args.join(" ")}`, code: 2 };
  };
}

function deps(
  adapter: ScriptedSessionAdapter,
  over: Partial<SessionLauncherDeps> = {},
  calls: string[][] = [],
): SessionLauncherDeps {
  return {
    adapter,
    self: { exec: "/usr/local/bin/node", args: ["/opt/kodel/dist/kodel.js"] },
    root: ROOT,
    stateBase: BASE,
    environment: ENV,
    rules: [],
    servedTools: SERVED,
    which: async (name) => (name === "claude" ? "/usr/bin/claude" : undefined),
    exec: fakeExec(adapter, {}, calls),
    platform: "darwin",
    clock: () => 1_000,
    uuid: () => UUID,
    // These tests build today's `claude -p` worker: the project says so (`worker: print`). The terminal
    // mechanism has its own rows below, and the real one runs in `tests/pty`.
    engines: async () => ({ ok: true, engines: { claude: { worker: "print" } } }),
    ...over,
  };
}

const INIT = (id: string) =>
  JSON.stringify({ type: "system", subtype: "init", session_id: id, tools: [] });
const RESULT = (id: string) => JSON.stringify({ type: "result", session_id: id, num_turns: 2 });

describe("task_9pns the claude profile", () => {
  test("task_9pns_launch_spec", async () => {
    const adapter = new ScriptedSessionAdapter();
    const launcher = createSessionWorkerLauncher(deps(adapter));
    const { name } = await launcher.start({
      runId: RUN,
      workdir: "/proj/.kodel/worktrees/x",
      title: "Add a flag",
    });
    expect(name).toBe(`kw-${RUN}`);
    const spec = adapter.specs[0];
    if (!spec) throw new Error("no spec");
    expect(spec.cwd).toBe("/proj/.kodel/worktrees/x");
    expect(spec.name).toBe(`kw-${RUN}`);
    expect(spec.origin).toBe("cli");
    expect(spec.timeoutMs).toBe(WORKER_TIMEOUT_MS);
    expect(WORKER_TIMEOUT_MS).toBe(12 * 3_600_000);
    expect(spec.inheritEnv).toBe(false);
    const argv = spec.argv ?? [];
    expect(argv.slice(0, 3)).toEqual([
      "claude",
      "-p",
      workerPrompt(RUN, "Add a flag", "/proj/.kodel/worktrees/x"),
    ]);
    expect(argv).toContain("--output-format");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv[argv.indexOf("--session-id") + 1]).toBe(UUID);
    expect(argv).not.toContain("--resume");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(argv).not.toContain("--max-budget-usd");
    expect(argv).not.toContain("--model");
    const mcp = JSON.parse(argv[argv.indexOf("--mcp-config") + 1] ?? "{}") as {
      mcpServers: { kodel: { command: string; args: string[]; env?: Record<string, string> } };
    };
    expect(mcp.mcpServers.kodel.command).toBe("/usr/local/bin/node");
    expect(mcp.mcpServers.kodel.args).toEqual([
      "/opt/kodel/dist/kodel.js",
      "--root",
      ROOT,
      "mcp",
      "--no-decisions",
      "--no-wait-hint",
    ]);
    expect(mcp.mcpServers.kodel.env).toEqual({ KODEL_STATE_DIR: "/home/u/state" });
    // Without `KODEL_STATE_DIR` in the TUI's environment the server gets none.
    const { KODEL_STATE_DIR: _none, ...plainEnv } = ENV;
    const other = new ScriptedSessionAdapter();
    await createSessionWorkerLauncher(deps(other, { environment: plainEnv })).start({
      runId: RUN,
      workdir: "/proj",
      title: "t",
    });
    const otherArgv = other.specs[0]?.argv ?? [];
    expect(otherArgv[otherArgv.indexOf("--mcp-config") + 1]).not.toContain("KODEL_STATE_DIR");
    // The first prompt: the run, the title, the workdir, never `pipeline_start`, and no body.
    const prompt = argv[2] ?? "";
    expect(prompt).toContain(RUN);
    expect(prompt).toContain('"Add a flag"');
    expect(prompt).toContain("/proj/.kodel/worktrees/x");
    expect(prompt).toContain("never call pipeline_start");
    expect(workerPrompt(RUN, "t", "/w")).not.toContain("body");
    // The lists are the ones the profile builds.
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(workerAllowlist(SERVED).join(","));
    expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe(workerDenylist(ROOT, BASE).join(","));
  });

  test("task_9pns_launcher_resumes_the_same_session_under_the_decisions_name", async () => {
    const adapter = new ScriptedSessionAdapter();
    const environment = { ...ENV };
    const launcher = createSessionWorkerLauncher(deps(adapter, { environment }));
    await launcher.start({ runId: RUN, workdir: "/proj", title: "t" });
    const first = adapter.only();
    adapter.finish(
      first.id,
      { state: "exited", exitCode: 0, since: 9_000 },
      `${INIT(UUID)}\n${RESULT(UUID)}\n`,
    );
    // The environment of the moment: a changed PATH shows up in the resume.
    environment.PATH = "/opt/new/bin:/usr/bin";
    const decision: WorkerDecision = {
      ...DECISION,
      reason:
        "fine, token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz0123456789",
    };
    const { name } = await launcher.resume({
      runId: RUN,
      workdir: "/proj",
      sessionId: UUID,
      decision,
    });
    expect(name).toBe(`kw-${RUN}-d17`);
    const spec = adapter.specs[1];
    if (!spec) throw new Error("no resume spec");
    const argv = spec.argv ?? [];
    expect(spec.name).toBe(`kw-${RUN}-d17`);
    expect(spec.cwd).toBe(adapter.specs[0]?.cwd ?? "");
    expect(argv[argv.indexOf("--resume") + 1]).toBe(UUID);
    expect(argv).not.toContain("--session-id");
    expect(argv[2]).toBe(resumePrompt(RUN, decision));
    expect(argv[2]).toContain('gate "plan-approval" approved');
    expect(argv[2]).toContain(`Continue Kodel run ${RUN}`);
    expect(argv[2]).toContain("never call pipeline_start");
    // A secret-shaped reason is redacted before it is argv.
    expect(argv[2]).not.toContain("sk-ant-api03");
    expect(argv[2]).toContain("[REDACTED:");
    // Every other flag and both lists as the first session's.
    const flags = (a: string[]) =>
      a.filter((x) => x.startsWith("--") && x !== "--session-id" && x !== "--resume");
    expect(flags(argv)).toEqual(flags(adapter.specs[0]?.argv ?? []));
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(
      (adapter.specs[0]?.argv ?? [])[(adapter.specs[0]?.argv ?? []).indexOf("--allowedTools") + 1],
    );
    expect(spec.env?.PATH).toBe("/opt/new/bin:/usr/bin");
    expect(spec.timeoutMs).toBe(WORKER_TIMEOUT_MS);
    expect(spec.origin).toBe("cli");
  });

  test("task_9pns_session_id_from_argv_then_tail", () => {
    const first = { name: `kw-${RUN}`, command: `claude -p prompt --session-id ${UUID} --verbose` };
    expect(sessionIdOf([first])).toBe(UUID);
    // The tail wins when both exist and differ.
    expect(sessionIdOf([first], `${INIT(OTHER)}\n${RESULT(OTHER)}`)).toBe(OTHER);
    // No `--session-id`: the newest `-d` record's `--resume`.
    const d4 = { name: `kw-${RUN}-d4`, command: `claude -p p --resume ${OTHER}`, decisionSeq: 4 };
    const d9 = { name: `kw-${RUN}-d9`, command: `claude -p p --resume ${UUID}`, decisionSeq: 9 };
    expect(sessionIdOf([{ name: `kw-${RUN}`, command: "claude -p p" }, d4, d9])).toBe(UUID);
    // A mangled uuid falls through to the next source, then to the tail, then to none.
    const mangled = { name: `kw-${RUN}`, command: "claude -p p --session-id [REDACTED:x]" };
    expect(sessionIdOf([mangled, d4])).toBe(OTHER);
    expect(sessionIdOf([mangled], RESULT(UUID))).toBe(UUID);
    expect(sessionIdOf([mangled])).toBeUndefined();
    expect(sessionIdOf([])).toBeUndefined();
  });

  test("task_9pns_session_id_last_flag_wins_over_the_title", () => {
    // The prompt (with the title) precedes the flags: a title holding `--session-id <other>` does not win.
    const command = `claude -p Kodel run ${RUN} exists for the task "--session-id ${OTHER}" and is yours --output-format stream-json --session-id ${UUID}`;
    expect(sessionIdOf([{ name: `kw-${RUN}`, command }])).toBe(UUID);
  });

  test("task_9pns_worker_env_drops_claude_markers_and_kodel", () => {
    const env = workerEnv(ENV);
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/u",
      CLAUDE_CONFIG_DIR: "/home/u/.claude",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(validateSpec({ argv: ["claude"], cwd: "/proj", env })).toBeUndefined();
  });

  test("task_9pns_allow_and_deny_lists", () => {
    const allowed = workerAllowlist(SERVED);
    const decisions = decisionTools({ gate: true, pipelineChange: true }, {
      decideGate: async () => ({ ok: false, code: "INTERNAL", message: "" }),
      acceptChange: async () => ({ ok: false, code: "INTERNAL", message: "" }),
    } as never).map((t) => t.name);
    expect(decisions).toEqual(["pipeline_decide_gate", "pipeline_accept_change"]);
    for (const name of SERVED) expect(allowed).toContain(`mcp__kodel__${name}`);
    for (const name of decisions) expect(allowed).not.toContain(`mcp__kodel__${name}`);
    expect(allowed.filter((t) => !t.startsWith("mcp__kodel__"))).toEqual([...WORKER_TOOLS]);
    expect(allowed).not.toContain("WebFetch");
    expect(allowed).not.toContain("Monitor");
    // Also when the served list is given with the decision tools in it: they never reach the allowlist.
    expect(workerAllowlist([...SERVED, ...decisions]).filter((t) => t.includes("decide"))).toEqual(
      [],
    );

    const denied = workerDenylist(ROOT, BASE);
    for (const tool of WORKER_DENIED) expect(denied).toContain(tool);
    for (const spelling of ["*kodel*", "*main.ts*", "*kodel.js*"]) {
      for (const verb of [
        "gate",
        "ack",
        "seal",
        "resume",
        "migrate",
        "pipeline changes apply",
        "pipeline changes discard",
        "pipeline changes restore",
        "pipeline proposals apply",
        "pipeline proposals discard",
        "task approve",
        ...AGENT_HUMAN_COMMANDS,
      ]) {
        expect(denied).toContain(`Bash(${spelling} ${verb}*)`);
      }
      expect(denied).toContain(`Bash(${spelling} wait r_*)`);
    }
    for (const path of [
      ".kodel/runs/**",
      ".kodel/pipelines/**",
      ".kodel/tasks/**",
      ".kodel/config.yaml",
      ".kodel/proposals/**",
      ".mcp.json",
      ".claude/settings*.json",
    ]) {
      for (const tool of ["Edit", "Write"]) {
        expect(denied).toContain(`${tool}(${path})`);
        expect(denied).toContain(`${tool}(//proj/${path})`);
      }
    }
    expect(denied).toContain("Edit(//home/u/.kodel/**)");
    expect(denied).toContain("Write(//home/u/.kodel/**)");
    // A state base under the root is covered by the root's patterns.
    expect(workerDenylist(ROOT, "/proj/.kodel").some((d) => d.includes("//proj/.kodel/**"))).toBe(
      false,
    );

    // The glob as Claude Code documents it: `*` matches anything. What `dev.yaml` runs passes; the human-only commands do not.
    const globToRegExp = (glob: string) =>
      new RegExp(
        `^${glob
          .split("*")
          .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      );
    const bashPatterns = denied
      .filter((d) => d.startsWith("Bash("))
      .map((d) => globToRegExp(d.slice(5, -1)));
    const refused = (command: string) => bashPatterns.some((re) => re.test(command));
    for (const command of [
      "bun test packages/cli/test/x.test.ts",
      "bun run typecheck",
      "git status",
      "git add -A && git commit -s -m 'x'",
      "git fetch origin main && git merge --signoff origin/main",
      "git push -u origin HEAD",
      "gh pr create --draft --base main",
      "gh pr view --json mergeable",
      "mktemp -u",
      "git worktree list",
      "cd /proj/.kodel/worktrees/r_0abc && bun test; wait",
      "bun packages/cli/src/main.ts agent ls --json",
      "bun packages/cli/src/main.ts agent logs kw-r_0abc",
      "bun packages/cli/src/main.ts status",
      "bun packages/cli/src/main.ts task list",
    ]) {
      expect(refused(command)).toBe(false);
    }
    for (const command of [
      "kodel gate approve r_0abc",
      "kodel wait r_0abc",
      "bun packages/cli/src/main.ts wait r_0abc --timeout 10",
      "node dist/kodel.js resume r_0abc",
      "kodel ack r_0abc",
      "kodel seal r_0abc",
      "kodel migrate r_0abc",
      "kodel pipeline changes apply r_0abc",
      "kodel pipeline proposals discard x",
      "kodel task approve TASK-1",
      "kodel agent stop kw-r_0abc",
      "kodel agent rm kw-r_0abc",
      "kodel agent exec --name x sleep 1",
      "kodel agent forget-name kw-r_0abc",
    ]) {
      expect(refused(command)).toBe(true);
    }
  });

  test("task_9pns_auth_probe", async () => {
    const probe =
      (stdout: string): Exec =>
      async () => ({ stdout, stderr: "", code: 0 });
    expect(await authProbe(probe('{"loggedIn":false}'), () => 0)).toEqual({
      known: true,
      loggedIn: false,
    });
    expect(await authProbe(probe('{"loggedIn":true,"authMethod":"oauth"}\n'), () => 0)).toEqual({
      known: true,
      loggedIn: true,
    });
    expect(await authProbe(probe("not json"), () => 0)).toEqual({ known: false });
    expect(
      await authProbe(
        async () => {
          throw new Error("no claude");
        },
        () => 0,
      ),
    ).toEqual({ known: false });
    // A probe that answers after the deadline (the injected clock) is unknown, whatever it says.
    let t = 0;
    expect(await authProbe(probe('{"loggedIn":false}'), () => (t += 10_000), 10_000)).toEqual({
      known: false,
    });
  });
});

describe("task_9pns the session launcher over the scripted adapter", () => {
  test("task_9pns_status_progress_logs_and_stop", async () => {
    const adapter = new ScriptedSessionAdapter();
    const calls: string[][] = [];
    const launcher = createSessionWorkerLauncher(deps(adapter, {}, calls));
    await launcher.start({ runId: RUN, workdir: "/proj", title: "t" });
    const first = adapter.only();
    adapter.finish(
      first.id,
      { state: "exited", exitCode: 0, since: 9_000 },
      `${INIT(UUID)}\n${RESULT(UUID)}\n`,
    );
    await launcher.resume({ runId: RUN, workdir: "/proj", sessionId: UUID, decision: DECISION });
    // One live agent a run: the first resumed session ends before the next decision is resumed.
    adapter.finish(adapter.only(`kw-${RUN}-d17`).id, {
      state: "exited",
      exitCode: 0,
      since: 9_500,
    });
    await launcher.resume({
      runId: RUN,
      workdir: "/proj",
      sessionId: UUID,
      decision: { ...DECISION, seq: 23 },
    });
    // Another run's records are not this run's.
    await launcher.start({ runId: "r_0mw53d7fj_zzzz", workdir: "/proj", title: "other" });
    calls.length = 0;
    const statuses = await launcher.statuses([RUN, "r_0mw53d7fj_zzzz", "r_0mw53d7fj_none"]);
    expect(calls.filter((c) => c.includes("ls")).length).toBe(1);
    expect(calls[0]?.slice(0, 4)).toEqual([
      "/usr/local/bin/node",
      "/opt/kodel/dist/kodel.js",
      "--root",
      ROOT,
    ]);
    const mine = statuses.get(RUN);
    expect(mine).toMatchObject({
      name: `kw-${RUN}-d23`,
      state: "running",
      resumes: 2,
      resumed: [17, 23],
      decisionSeq: 23,
      sessionId: UUID,
    });
    expect(statuses.get("r_0mw53d7fj_zzzz")?.name).toBe("kw-r_0mw53d7fj_zzzz");
    expect(statuses.has("r_0mw53d7fj_none")).toBe(false);
    // The digest of the latest record, through `agent logs <latest> --stdout --bytes 262144`.
    const latest = adapter.only(`kw-${RUN}-d23`);
    adapter.finish(
      latest.id,
      { state: "running" },
      `${INIT(UUID)}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "going on" }] } })}\n`,
    );
    calls.length = 0;
    const progress = await launcher.progress(RUN);
    expect(calls[0]?.slice(4)).toEqual([
      "agent",
      "logs",
      latest.id,
      "--stdout",
      "--bytes",
      "262144",
    ]);
    expect(progress.lines).toEqual([
      "· resumed (session 3)",
      "init · 0 tools (kodel 0)",
      "> going on",
    ]);
    // A cut tail: the command's closing line is not an event.
    adapter.finish(latest.id, { state: "running" }, `${INIT(UUID)}\n${RESULT(UUID)}\n`, false);
    expect((await launcher.progress(RUN)).lines.at(-1)).toBe("result: ok · 2 turns");
    // `logs` and `stop` go through the adapter, on the latest record.
    expect(await launcher.logs(RUN)).toContain(`"session_id":"${UUID}"`);
    await launcher.stop(RUN);
    expect(latest.status.state).toBe("killed");
    expect(first.status.state).toBe("exited");
    // A problem entry reads as unknown.
    adapter.unreadableEntry = true;
    const unknown = createSessionWorkerLauncher(
      deps(adapter, {
        exec: async () => ({
          stdout: JSON.stringify([
            {
              id: "a_000000009_fake",
              name: `kw-${RUN}`,
              status: { state: "lost" },
              problem: "CANNOT_READ",
            },
          ]),
          stderr: "",
          code: 0,
        }),
      }),
    );
    expect((await unknown.statuses([RUN])).get(RUN)).toMatchObject({
      state: "unknown",
      label: "unknown (cannot be read)",
    });
    // A read that fails throws: the loop marks every worker unknown.
    const failing = createSessionWorkerLauncher(
      deps(adapter, { exec: async () => ({ stdout: "", stderr: "boom", code: 1 }) }),
    );
    await expect(failing.statuses([RUN])).rejects.toThrow("kodel agent ls failed");
    expect(startedOf("a_0mw53d7fj_abcd")).toBe(Number.parseInt("0mw53d7fj", 36));
  });

  test("task_9pns_preflight_refuses_before_any_run_and_an_unreadable_probe_lets_the_start_go_on", async () => {
    const adapter = new ScriptedSessionAdapter();
    const ok = { dialog: false, taskLink: true, pipelines: 1 };
    const refusal = async (over: Partial<SessionLauncherDeps>, input = ok) => {
      const result = await createSessionWorkerLauncher(deps(adapter, over)).preflight(input);
      return result.ok ? undefined : result.reason;
    };
    // task_9pns_preflight_refuses_before_any_run_win32
    expect(await refusal({ platform: "win32" })).toBe("agents are not supported on Windows yet");
    // task_9pns_preflight_refuses_before_any_run_dialog
    expect(await refusal({}, { ...ok, dialog: true })).toContain("decisions.dialog");
    // task_9pns_preflight_refuses_before_any_run_no_claude
    expect(await refusal({ which: async () => undefined })).toBe("claude was not found on PATH");
    // task_9pns_preflight_refuses_signed_out
    expect(await refusal({ exec: fakeExec(adapter, { stdout: '{"loggedIn":false}' }) })).toBe(
      "claude is not signed in (claude auth status): run claude auth login",
    );
    // task_9pns_preflight_refuses_before_any_run_task_link
    expect(await refusal({}, { ...ok, taskLink: false })).toContain(
      "tasks.on_run.mode is disabled",
    );
    // task_9pns_preflight_refuses_before_any_run_replace_rule
    expect(await refusal({ rules: [{ name: "x", pattern: /x/g, replace: () => "y" }] })).toBe(
      "a project redaction rule cannot be given to a background agent",
    );
    // task_9pns_preflight_refuses_before_any_run_no_pipeline
    expect(await refusal({}, { ...ok, pipelines: 0 })).toBe("no pipeline loads");
    // task_9pns_unreadable_probe_lets_the_start_go_on: a probe that fails, is late or prints no JSON.
    expect(await refusal({ exec: fakeExec(adapter, { throws: true }) })).toBeUndefined();
    expect(
      await refusal({ exec: fakeExec(adapter, { stdout: "Logged in as x" }) }),
    ).toBeUndefined();
    let t = 0;
    expect(
      await refusal({
        clock: () => (t += 60_000),
        exec: fakeExec(adapter, { stdout: '{"loggedIn":false}' }),
      }),
    ).toBeUndefined();
    // The preflight writes nothing and starts nothing.
    expect(adapter.starts).toBe(0);
  });
});

// ── a real host and the fake launcher ───────────────────────────────────────

const ONE = [
  "name: one",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write it",
  "    checks:",
  "      - { kind: command, command: 'node -e 0' }",
  "  - slug: approve",
  "    kind: human",
  "    prompt: ok?",
  "  - slug: impl",
  "    kind: agent",
  "    prompt: implement it",
  "  - slug: build",
  "    kind: command",
  "    command: node -e 0",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: impl }",
  "  - { from: impl, to: build }",
  "  - { from: approve, to: write, when: rejected }",
  "  - { from: build, to: write, when: failed }",
  "",
].join("\n");

const CONFIG =
  "worktree:\n  mode: off\ntasks:\n  enabled: true\n  adapters:\n    local:\n      prefix: KDL\n";

let dir: string;
const made: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kodel-worker-"));
  made.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  mkdirSync(join(dir, ".kodel", "pipelines"), { recursive: true });
  writeFileSync(join(dir, ".kodel", "pipelines", "one.yaml"), ONE);
  writeFileSync(join(dir, ".kodel", "config.yaml"), CONFIG);
  writeFileSync(join(dir, ".gitignore"), ".kodel/runs\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
});
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const storeRoot = () => join(dir, ".kodel");
const host = (environment: NodeJS.ProcessEnv = {}) =>
  new LocalPipelineHost({ root: dir, heartbeatMs: 0, environment });

async function seedTask(title = "Add a flag", body?: string): Promise<string> {
  const opened = await openTaskService({ storeRoot: storeRoot() });
  if (!opened) throw new Error("tasks are off");
  const made_ = await opened.service.create({ title, ...(body === undefined ? {} : { body }) });
  if (!made_.ok) throw new Error("could not seed the task");
  return (made_.task as { key: string }).key;
}

async function taskOf(key: string) {
  const opened = await openTaskService({ storeRoot: storeRoot() });
  if (!opened) throw new Error("tasks are off");
  const read = await opened.service.get({ key });
  if (!read.ok) throw new Error("no task");
  return read.task as { status: string; state: string; runs: string[] };
}

async function options(h: LocalPipelineHost, launcher: WorkerLauncher) {
  return createWorkerOptions({
    host: h,
    tasks: await openTasksForTui(storeRoot()),
    launcher,
    dialog: false,
    root: dir,
    version: "0.1.0-test",
  });
}

const journalOf = (runId: string) =>
  readFileSync(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("task_9pns the start through a real host", () => {
  test("task_9pns_start_order_and_failures_started", async () => {
    const key = await seedTask("Add a flag", "The body of the task.\nTwo lines.");
    const launcher = new FakeLauncher();
    const h = host();
    const opts = await options(h, launcher);
    const check = await opts.prepareStart?.(key);
    expect(check).toEqual({ ok: true, pipelines: ["one"] });
    expect(launcher.preflights[0]).toEqual({ dialog: false, taskLink: true, pipelines: 1 });
    const started = await opts.startTask?.(key, "one");
    expect(started?.ok).toBe(true);
    const runId = started?.runId ?? "";
    expect(started?.message).toBe(`Started ${key}: run ${runId} (agent kw-${runId}).`);
    expect(launcher.starts).toEqual([{ runId, workdir: dir, title: "Add a flag" }]);
    // The run holds the task text (title, a blank line, the body); the task is in progress with the run.
    const summaries = await h.runSummaries();
    // (the host flattens the whitespace of a task when it records it)
    expect(summaries[0]?.meta.task).toContain("Add a flag");
    expect(summaries[0]?.meta.task).toContain("The body of the task.");
    expect(taskTextOf({ title: "T" })).toBe("T");
    expect(taskTextOf({ title: "T", body: "  " })).toBe("T");
    expect(await taskOf(key)).toMatchObject({ status: "progress", runs: [runId] });
    // The first node is the agent's: the worker drives it with pipeline_next_step.
    const run = (await h.open(runId)) as LocalRun;
    expect(await run.nextStep()).toMatchObject({ node: { slug: "write" } });
  });

  test("task_9pns_start_order_and_failures_done_task_is_refused", async () => {
    const key = await seedTask();
    const opened = await openTaskService({ storeRoot: storeRoot() });
    await opened?.service.update({ key, status: "done" });
    const launcher = new FakeLauncher();
    const h = host();
    const opts = await options(h, launcher);
    const started = await opts.startTask?.(key, "one");
    expect(started).toEqual({ ok: false, message: `Could not start ${key}: the task is done.` });
    expect(await h.runSummaries()).toEqual([]);
    expect(launcher.starts).toEqual([]);
  });

  test("task_9pns_start_order_and_failures_reused_starts_no_worker", async () => {
    const key = await seedTask();
    const launcher = new FakeLauncher();
    const h = host();
    const opts = await options(h, launcher);
    // A run for the same task text, started outside the TUI and not tied to the task: the host answers
    // `reused`, and no worker is started.
    const outside = await h.start({ pipeline: "one", task: "Add a flag", restart: true });
    const started = await opts.startTask?.(key, "one");
    expect(started?.ok).toBe(false);
    expect(started?.message).toBe(
      `${key} has a run already going: ${outside.run.runId} (started outside the TUI).`,
    );
    expect(launcher.starts).toEqual([]);
    // A run tied to the task is found before the host is asked.
    const tied = await h.start({
      pipeline: "one",
      task: "other words",
      restart: true,
      task_key: key,
    });
    const again = await opts.startTask?.(key, "one");
    expect(again?.message).toBe(`${key} is already started: run ${tied.run.runId}.`);
    // Without the tie the host itself answers `reused`, and no worker is started either.
    const untied = await h.start({ pipeline: "one", task: "Add a flag", restart: true });
    expect(untied.status).toBe("reused");
  });

  test("task_9pns_restart_true_does_not_double_start", async () => {
    const key = await seedTask();
    const h = host();
    const input = {
      pipeline: "one",
      task: "Add a flag",
      restart: true,
      task_key: key,
      caller: { name: "kodel-tui", version: "0" },
    };
    const first = await h.start(input);
    const second = await h.start(input);
    expect(first.status).toBe("started");
    expect(second.status).toBe("reused");
    expect(second.run.runId).toBe(first.run.runId);
  });

  test("task_9pns_run_made_without_agent_is_reused_on_the_next_start", async () => {
    const key = await seedTask();
    const launcher = new FakeLauncher();
    launcher.failStart = new SessionError("HOLDER_BOOT_FAILED", "the holder did not answer");
    const h = host();
    const opts = await options(h, launcher);
    const started = await opts.startTask?.(key, "one");
    expect(started?.ok).toBe(false);
    const runId = started?.runId ?? "";
    expect(started?.message).toBe(
      `run ${runId} was made but no agent was started: the holder did not answer. Any agent in the project continues it with pipeline_next_step and this run id.`,
    );
    // The run exists, is not cancelled, and a second start finds it; any agent continues it.
    const run = (await h.open(runId)) as LocalRun;
    expect((await run.state()).status).toBe("running");
    launcher.failStart = undefined;
    const again = await opts.startTask?.(key, "one");
    expect(again?.message).toBe(`${key} is already started: run ${runId}.`);
    expect(launcher.starts.length).toBe(1);
    expect(await run.nextStep()).toMatchObject({ node: { slug: "write" } });
  });

  test("task_9pns_tui_start_records_client_kodel_tui", async () => {
    const key = await seedTask();
    const launcher = new FakeLauncher();
    const opts = await options(host({}), launcher);
    const started = await opts.startTask?.(key, "one");
    const first = journalOf(started?.runId ?? "")[0];
    expect(first?.event).toBe("run_started");
    expect(first?.executor).toEqual({
      client: { value: { name: "kodel-tui", version: "0.1.0-test" }, source: "observed" },
    });
  });

  test("task_9pns_tui_start_records_the_terminals_session_when_set", async () => {
    const key = await seedTask();
    const launcher = new FakeLauncher();
    const opts = await options(
      host({ CLAUDE_CODE_SESSION_ID: "abcdef12-3456-4789-8abc-def012345678" }),
      launcher,
    );
    const started = await opts.startTask?.(key, "one");
    const first = journalOf(started?.runId ?? "")[0];
    expect(first?.executor).toMatchObject({
      client: { value: { name: "kodel-tui" } },
      session: { value: "abcdef12-3456-4789-8abc-def012345678", source: "observed-env" },
    });
  });

  test("task_9pns_progress_restart_links_the_second_run", async () => {
    const key = await seedTask();
    const launcher = new FakeLauncher();
    const h = host();
    const opts = await options(h, launcher);
    const first = await opts.startTask?.(key, "one");
    const run = (await h.open(first?.runId ?? "")) as LocalRun;
    await run.cancel();
    expect(await taskOf(key)).toMatchObject({ status: "progress" });
    const second = await opts.startTask?.(key, "one");
    expect(second?.ok).toBe(true);
    expect(second?.runId).not.toBe(first?.runId);
    expect(await taskOf(key)).toMatchObject({
      status: "progress",
      runs: [first?.runId, second?.runId],
    });
  });

  test("task_9pns_start_and_resume_write_only_the_session_record", async () => {
    const key = await seedTask();
    const launcher = new FakeLauncher();
    const h = host();
    const opts = await options(h, launcher);
    const started = await opts.startTask?.(key, "one");
    const runId = started?.runId ?? "";
    const run = (await h.open(runId)) as LocalRun;
    await run.completeStep("write", 1);
    await run.waitForRest(5_000);
    launcher.exited(runId, Date.now());
    await (await host().open(runId))?.decideHuman("approve", "approved");
    const before = {
      journal: readFileSync(join(dir, ".kodel", "runs", runId, "journal.jsonl")),
      state: readFileSync(join(dir, ".kodel", "runs", runId, "state.json")),
    };
    const resumed = await opts.resumeWorker?.(
      runId,
      decisionOf(await run.journal()).decision?.seq ?? 0,
    );
    expect(resumed?.ok).toBe(true);
    expect(launcher.resumes[0]?.decision).toMatchObject({
      kind: "gate",
      node: "approve",
      outcome: "approved",
    });
    expect(
      readFileSync(join(dir, ".kodel", "runs", runId, "journal.jsonl")).equals(before.journal),
    ).toBe(true);
    expect(
      readFileSync(join(dir, ".kodel", "runs", runId, "state.json")).equals(before.state),
    ).toBe(true);
    // A resume for a decision that is not the last one is refused before anything is started.
    const stale = await opts.resumeWorker?.(runId, 1);
    expect(stale?.message).toBe(`run ${runId} was not resumed: the run moved on.`);
    expect(launcher.resumes.length).toBe(1);
  });

  test("task_9pns_decision_from_the_cli_is_offered_and_an_agent_decision_is_not", async () => {
    const key = await seedTask();
    const launcher = new FakeLauncher();
    const h = host();
    const opts = await options(h, launcher);
    const started = await opts.startTask?.(key, "one");
    const runId = started?.runId ?? "";
    const run = (await h.open(runId)) as LocalRun;
    await run.completeStep("write", 1);
    await run.waitForRest(5_000);
    launcher.exited(runId, Date.now());
    const look = async () => {
      const m = withWorkers(
        initialModel(await loadSessions(h, Date.now()), "project", Date.now()),
        await launcher.statuses([runId]),
        false,
      );
      return m.offers[runId];
    };
    expect((await look())?.line).toBe("agent waiting for you");
    // A second host instance, as `kodel gate` and a client's dialog decide.
    const other = (await host().open(runId)) as LocalRun;
    await other.decideHuman("approve", "approved");
    await other.waitForRest(5_000);
    const offered = await look();
    expect(offered?.line).toBe("agent exited at your decision · s resumes");
    expect(offered?.offer).toMatchObject({ decision: { outcome: "approved", node: "approve" } });
    const resumed = await opts.resumeWorker?.(runId, offered?.offer?.seq ?? 0);
    expect(resumed?.ok).toBe(true);
    expect(resumePrompt(runId, launcher.resumes[0]?.decision ?? DECISION)).toContain(
      'gate "approve" approved',
    );

    // An agent's decision at the next gate is not offered: the card says so.
    const second = await opts.startTask?.(await seedTask("Another"), "one");
    const run2 = (await h.open(second?.runId ?? "")) as LocalRun;
    await run2.completeStep("write", 1);
    await run2.waitForRest(5_000);
    launcher.exited(run2.runId, Date.now());
    await ((await host().open(run2.runId)) as LocalRun).decideHuman(
      "approve",
      "approved",
      undefined,
      { instruction: "approve it" },
    );
    const m = withWorkers(
      initialModel(await loadSessions(h, Date.now()), "project", Date.now()),
      await launcher.statuses([run2.runId]),
      false,
    );
    expect(m.offers[run2.runId]?.offer).toBeUndefined();
    expect(m.offers[run2.runId]?.line).toBe("agent exited; an agent decided and goes on");
    const sessions = await loadSessions(h, Date.now());
    const s2 = sessions.sessions.find((s) => s.id === run2.runId);
    expect(s2 && resumeOffer(s2, launcher.statusMap.get(run2.runId), false).offer).toBeUndefined();
  });
});

// ── the real adapter ─────────────────────────────────────────────────────────

const groupReadable = ownProcessGroup() !== undefined;
const real = test.skipIf(
  process.platform === "win32" || (!groupReadable && process.env.KODEL_REQUIRE_PROCTABLE !== "1"),
);
const entry = join(import.meta.dir, "../../local/src/session-holder-entry.ts");
const main = join(import.meta.dir, "../src/main.ts");

/** Where the fake `claude` of `fakeClaude(base)` appends one JSON line per start: `{ env, argv }` as it saw them. */
const seenFile = (base: string) => join(base, "seen.jsonl");

/**
 * A `claude` on PATH that prints its environment and argv as stream-json and exits 0. It also appends
 * them to `seenFile(base)`: the holder redacts the stored tail, and a random temp path can be tagged
 * `high-entropy` there, so what the child saw is read from its own file, not from the record.
 */
function fakeClaude(base: string): string {
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(base, "claude.mjs");
  writeFileSync(
    script,
    [
      "import { appendFileSync } from 'node:fs';",
      "const argv = process.argv.slice(2);",
      "const valueOf = (flag) => { const at = argv.indexOf(flag); return at < 0 ? undefined : argv[at + 1]; };",
      "const id = valueOf('--session-id') ?? valueOf('--resume') ?? 'none';",
      "const seen = JSON.stringify({ env: process.env, argv });",
      `appendFileSync(${JSON.stringify(seenFile(base))}, seen + '\\n');`,
      "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: id, tools: ['Bash'] }) + '\\n');",
      "process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: seen }] } }) + '\\n');",
      "process.stdout.write(JSON.stringify({ type: 'result', session_id: id, num_turns: 1 }) + '\\n');",
      "",
    ].join("\n"),
  );
  const claude = join(bin, "claude");
  writeFileSync(
    claude,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
  );
  chmodSync(claude, 0o755);
  return bin;
}

describe("task_9pns the real adapter", () => {
  real(
    "task_9pns_child_env_and_resume_real",
    async () => {
      const base = mkdtempSync(join(tmpdir(), "kodel-worker-real-"));
      made.push(base);
      const bin = fakeClaude(base);
      const stateDir = join(base, "state");
      const environment: Record<string, string | undefined> = {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: base,
        KODEL_STATE_DIR: stateDir,
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "the-terminal",
      };
      const adapter = new PipesSessionAdapter({
        base: stateDir,
        root: dir,
        baseEnv: environment,
        holder: { exec: process.execPath, args: [entry, "holder"] },
        intermediate: { exec: process.execPath, args: [entry] },
      });
      const launcher = createSessionWorkerLauncher({
        adapter,
        self: { exec: process.execPath, args: [main] },
        root: dir,
        stateBase: stateDir,
        environment,
        rules: [],
        servedTools: SERVED,
        which: async () => join(bin, "claude"),
        exec: (await import("../src/worker-launcher-session")).execChild,
        platform: process.platform,
        clock: Date.now,
        uuid: () => UUID,
        // Under `bun test` no terminal can run: the script stands for `claude -p`.
        engines: async () => ({ ok: true, engines: { claude: { worker: "print" } } }),
      });
      await launcher.start({ runId: RUN, workdir: dir, title: "real" });
      const first = (await adapter.list({ name: `kw-${RUN}` }))[0];
      if (!first) throw new Error("no record");
      await adapter.wait(first.id, { timeoutMs: 30_000 });
      const statuses = await launcher.statuses([RUN]);
      expect(statuses.get(RUN)).toMatchObject({ state: "exited", exitCode: 0, sessionId: UUID });
      const progress = await launcher.progress(RUN);
      const printed = progress.lines.find((l) => l.startsWith("> "));
      expect(printed).toBeDefined();
      // What the script saw, from its own file (the digest cuts the line, and the stored tail is redacted).
      const seenLines = readFileSync(seenFile(base), "utf8").trim().split("\n");
      expect(seenLines).toHaveLength(1);
      const seen = JSON.parse(seenLines[0] ?? "{}") as {
        env: Record<string, string>;
        argv: string[];
      };
      expect(seen.env.PATH).toBe(environment.PATH);
      expect(seen.env.HOME).toBe(base);
      expect(seen.env.KODEL_ENGINE).toBe("1");
      expect(Object.keys(seen.env).filter((k) => k.startsWith("KODEL_"))).toEqual(["KODEL_ENGINE"]);
      expect(seen.env.CLAUDECODE).toBeUndefined();
      expect(Object.keys(seen.env).some((k) => k.startsWith("CLAUDE_CODE_"))).toBe(false);
      expect(seen.argv[seen.argv.indexOf("--mcp-config") + 1]).toContain(
        `"KODEL_STATE_DIR":${JSON.stringify(stateDir)}`,
      );
      // The resume: `kw-<run>-d<seq>`, whose script sees `--resume <uuid>`.
      await launcher.resume({ runId: RUN, workdir: dir, sessionId: UUID, decision: DECISION });
      const second = (await adapter.list({ name: `kw-${RUN}-d17` }))[0];
      if (!second) throw new Error("no resume record");
      await adapter.wait(second.id, { timeoutMs: 30_000 });
      const resumedLines = readFileSync(seenFile(base), "utf8").trim().split("\n");
      expect(resumedLines).toHaveLength(2);
      const resumed = JSON.parse(resumedLines[1] ?? "{}") as { argv: string[] };
      expect(resumed.argv[resumed.argv.indexOf("--resume") + 1]).toBe(UUID);
      expect(resumed.argv).not.toContain("--session-id");
      expect((await launcher.statuses([RUN])).get(RUN)).toMatchObject({
        name: `kw-${RUN}-d17`,
        resumes: 1,
        sessionId: UUID,
      });
    },
    60_000,
  );

  real(
    "task_9pns_five_workers_real_adapter",
    async () => {
      const base = mkdtempSync(join(tmpdir(), "kodel-worker-real-"));
      made.push(base);
      const bin = fakeClaude(base);
      const stateDir = join(base, "state");
      const environment = {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: base,
        KODEL_STATE_DIR: stateDir,
      };
      const adapter = new PipesSessionAdapter({
        base: stateDir,
        root: dir,
        baseEnv: environment,
        holder: { exec: process.execPath, args: [entry, "holder"] },
        intermediate: { exec: process.execPath, args: [entry] },
      });
      const launcher = createSessionWorkerLauncher({
        adapter,
        self: { exec: process.execPath, args: [main] },
        root: dir,
        stateBase: stateDir,
        environment,
        rules: [],
        servedTools: SERVED,
        which: async () => join(bin, "claude"),
        exec: (await import("../src/worker-launcher-session")).execChild,
        platform: process.platform,
        clock: Date.now,
        uuid: () => UUID,
        // Under `bun test` no terminal can run: the script stands for `claude -p`.
        engines: async () => ({ ok: true, engines: { claude: { worker: "print" } } }),
      });
      const h = host();
      const opts = await options(h, launcher);
      const started: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const outcome = await opts.startTask?.(await seedTask(`Task ${i}`), "one");
        expect(outcome?.ok).toBe(true);
        started.push(outcome?.runId ?? "");
      }
      expect(new Set(started).size).toBe(5);
      const records = await adapter.list();
      expect(records.map((r) => r.name).sort()).toEqual(
        started.map((id) => workerNameOf(id)).sort(),
      );
      expect((await h.runSummaries()).length).toBe(5);
    },
    90_000,
  );
});

// ── kodel serve (TASK-G8KM, T-44) ───────────────────────────────────────────

describe("t44 the launcher for kodel serve", () => {
  test("t44_worker_status_carries_last_output_at", async () => {
    const adapter = new ScriptedSessionAdapter();
    const launcher = createSessionWorkerLauncher(deps(adapter));
    await launcher.start({ runId: RUN, workdir: ROOT, title: "t" });
    const first = adapter.only(`kw-${RUN}`);
    // The record has no last output: the status has none either.
    expect((await launcher.statuses([RUN])).get(RUN)?.lastOutputAt).toBeUndefined();
    expect("lastOutputAt" in ((await launcher.statuses([RUN])).get(RUN) ?? {})).toBe(false);
    adapter.finish(first.id, { state: "running", lastOutputAt: 7_000 }, "", true);
    expect((await launcher.statuses([RUN])).get(RUN)?.lastOutputAt).toBe(7_000);
    // A person's stop is told apart from a worker that died, and the daemon's port keeps both.
    adapter.finish(first.id, { state: "killed", reason: "stopped", lastOutputAt: 8_000 });
    const stopped = (await launcher.statuses([RUN])).get(RUN);
    expect(stopped).toMatchObject({ state: "killed", stopped: true, lastOutputAt: 8_000 });
    const view = (await serveLauncherOf(launcher).statuses([RUN])).get(RUN);
    expect(view).toMatchObject({ state: "killed", stopped: true, lastOutputAt: 8_000 });
    adapter.finish(first.id, { state: "killed", reason: "timeout" });
    const timedOut = (await serveLauncherOf(launcher).statuses([RUN])).get(RUN);
    expect(timedOut?.stopped).toBeUndefined();
    expect(timedOut?.lastOutputAt).toBeUndefined();
  });

  test("t45_list_entry_keeps_mode_and_agent", () => {
    const raw = {
      id: "a_000000000_0001",
      name: `kw-${RUN}`,
      command: "claude -p",
      mode: "pty",
      agent: { engine: "claude", session: UUID, source: "chosen", resumes: "a_000000000_0000" },
      status: { state: "lost", reason: "holder_gone", childAlive: true, group: "unread" },
    };
    expect(parseEntry(raw)).toEqual(raw as SessionListEntry);
    // an entry from before the record: neither field, and nothing is made up
    const older = parseEntry({ id: raw.id, status: { state: "exited", exitCode: 0 } });
    expect(older).toEqual({ id: raw.id, status: { state: "exited", exitCode: 0 } });
    // The output of a child is not trusted: a mode or an agent that the starter could not have written is dropped.
    const dropped: [string, Record<string, unknown>][] = [
      ["a mode that is none", { mode: "screen" }],
      ["an agent that is a string", { agent: "claude" }],
      ["an engine that is no profile name", { agent: { engine: "rm -rf" } }],
      ["a session that reads as a flag", { agent: { engine: "claude", session: "--resume" } }],
      ["a prompt beside the engine", { agent: { engine: "claude", prompt: "do it" } }],
      ["a source that is none", { agent: { engine: "claude", session: UUID, source: "seen" } }],
      ["a group that is none", { status: { state: "lost", group: "mine" } }],
    ];
    for (const [label, over] of dropped) {
      const entry = parseEntry({ id: raw.id, status: { state: "lost" }, ...over });
      expect(entry, label).toEqual({ id: raw.id, status: { state: "lost" } });
    }
  });

  test("t45_child_alive_reaches_the_rule", async () => {
    const adapter = new ScriptedSessionAdapter();
    const launcher = createSessionWorkerLauncher(deps(adapter));
    await launcher.start({ runId: RUN, workdir: ROOT, title: "t" });
    const first = adapter.only(`kw-${RUN}`);
    const viewOf = async () => (await serveLauncherOf(launcher).statuses([RUN])).get(RUN);
    // a running worker says nothing of it
    expect("childAlive" in ((await launcher.statuses([RUN])).get(RUN) ?? {})).toBe(false);
    expect("childAlive" in ((await viewOf()) ?? {})).toBe(false);
    // The holder is gone and the agent's process still runs: `agent ls --json` says so, and every layer up to
    // the view the serve rule reads keeps it.
    for (const status of [
      { state: "lost", reason: "holder_gone", childAlive: true },
      { state: "killed", reason: "stopped", childAlive: true },
      { state: "killed", reason: "timeout", childAlive: true },
    ] as const) {
      adapter.finish(first.id, { ...status });
      const worker = (await launcher.statuses([RUN])).get(RUN);
      expect(worker, status.reason).toMatchObject({ state: status.state, childAlive: true });
      expect(worker?.label).toContain("child still runs");
      expect(await viewOf(), status.reason).toMatchObject({
        state: status.state,
        childAlive: true,
      });
    }
    // after the person's stop the process is gone, and so is the mark
    adapter.finish(first.id, { state: "killed", reason: "stopped" });
    const stopped = (await launcher.statuses([RUN])).get(RUN);
    expect(stopped?.stopped).toBe(true);
    expect("childAlive" in (stopped ?? {})).toBe(false);
    expect("childAlive" in ((await viewOf()) ?? {})).toBe(false);
    // `childAlive: false`, as a record whose holder is gone spells it, is not the mark either
    adapter.finish(first.id, { state: "lost", reason: "holder_gone", childAlive: false });
    expect("childAlive" in ((await viewOf()) ?? {})).toBe(false);
    // a record that cannot be read is `unknown`, whatever its placeholder status says
    const status = (await launcher.statuses([RUN])).get(RUN);
    if (!status) throw new Error("no status");
    expect(serveWorkerOf({ ...status, childAlive: true }).childAlive).toBe(true);
  });

  test("t44_tui_start_takes_the_start_lock", async () => {
    const key = await seedTask();
    const launcher = new FakeLauncher();
    const short = () =>
      new LocalPipelineHost({
        root: dir,
        heartbeatMs: 0,
        environment: {},
        workerStartLock: { workerStartWaitMs: 150 },
      });
    const opts = await options(short(), launcher);
    // Another process (another store here) holds the lock: the TUI waits, then says so and starts nothing.
    let release: () => void = () => undefined;
    const held = host().withWorkerStartLock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await opts.startTask?.(key, "one")).toEqual({
      ok: false,
      message: `Could not start ${key}: another start is in progress, try again.`,
    });
    expect(launcher.starts).toEqual([]);
    expect(await short().runSummaries()).toEqual([]);
    release();
    await held;
    // The TUI holds it from the check to the end of the launch.
    let launched: () => void = () => undefined;
    launcher.hold = new Promise<void>((resolve) => {
      launched = resolve;
    });
    const starting = opts.startTask?.(key, "one");
    while (launcher.starts.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(short().withWorkerStartLock(async () => "in")).rejects.toMatchObject({
      code: "STATE_LOCKED",
    });
    launched();
    expect((await starting)?.ok).toBe(true);
    expect(await short().withWorkerStartLock(async () => "in")).toBe("in");
  });
});

// ── The wait command of a worker that stays alive at a wait (TASK-EKAV, T-45) ─────────────────

describe("t45 the worker's wait command", () => {
  const SELF = { exec: "/usr/local/bin/node", args: ["/opt/kodel/dist/kodel.js"], root: ROOT };

  test("t45_wait_command_carries_the_state_dir", () => {
    // Without a state dir of the starter: this very build, the project by its root, the run, the bound.
    expect(workerWaitCommand(SELF)).toBe(
      "/usr/local/bin/node /opt/kodel/dist/kodel.js --root /proj wait {run} --timeout 604800",
    );
    // With one: the worker's shell has no `KODEL_*` of its own, so the command spells it out.
    expect(workerWaitCommand({ ...SELF, stateDir: "/home/u/state" })).toBe(
      "env KODEL_STATE_DIR=/home/u/state /usr/local/bin/node /opt/kodel/dist/kodel.js --root /proj wait {run} --timeout 604800",
    );
    // The server of such a worker is given the command in place of `--no-wait-hint`, and keeps the
    // state dir in its own environment as before.
    const template = workerWaitCommand({ ...SELF, stateDir: "/home/u/state" });
    const server = JSON.parse(
      workerMcpConfig({ ...SELF, stateDir: "/home/u/state", waitCommand: template }),
    ).mcpServers.kodel;
    expect(server.args).toEqual([
      "/opt/kodel/dist/kodel.js",
      "--root",
      ROOT,
      "mcp",
      "--no-decisions",
      "--wait-command",
      template,
    ]);
    expect(server.env).toEqual({ KODEL_STATE_DIR: "/home/u/state" });
    // without a command the server is today's
    expect(JSON.parse(workerMcpConfig(SELF)).mcpServers.kodel.args.slice(-3)).toEqual([
      "mcp",
      "--no-decisions",
      "--no-wait-hint",
    ]);
  });

  test("t45_wait_command_is_quoted_and_passes_the_deny_list", () => {
    expect(shellQuote("/plain/path-1.2_x")).toBe("/plain/path-1.2_x");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("two words")).toBe("'two words'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("$(rm -rf ~)")).toBe("'$(rm -rf ~)'");
    expect(shellQuote("a;b")).toBe("'a;b'");

    // Every part is quoted by that one function: a root, a build and a state dir with spaces and quotes.
    const odd = {
      exec: "/Users/a b/bin/node",
      args: ["/opt/my kodel/dist/kodel.js"],
      root: "/work/it's here",
      stateDir: "/home/u/state $HOME",
    };
    const command = workerWaitCommand(odd).replace("{run}", RUN);
    expect(command).toBe(
      `env 'KODEL_STATE_DIR=/home/u/state $HOME' '/Users/a b/bin/node' '/opt/my kodel/dist/kodel.js' --root '/work/it'\\''s here' wait ${RUN} --timeout 604800`,
    );
    // A shell reads it back as the very words it was built from.
    const words = execFileSync("sh", ["-c", `printf '%s\\n' ${command}`], { encoding: "utf8" })
      .trimEnd()
      .split("\n");
    expect(words).toEqual([
      "env",
      `KODEL_STATE_DIR=${odd.stateDir}`,
      odd.exec,
      ...odd.args,
      "--root",
      odd.root,
      "wait",
      RUN,
      "--timeout",
      "604800",
    ]);

    // The deny list of a worker in a terminal refuses every person's command and not this one; the
    // `-p` worker's list refuses it, as before.
    const terminal = workerDenylist(ROOT, BASE, { terminal: true });
    const print = workerDenylist(ROOT, BASE);
    expect(print).toContain("Bash(*kodel* wait r_*)");
    expect(terminal.filter((p) => p.includes(" wait "))).toEqual([]);
    expect(print.filter((p) => !terminal.includes(p))).toEqual([
      "Bash(*kodel* wait r_*)",
      "Bash(*main.ts* wait r_*)",
      "Bash(*kodel.js* wait r_*)",
    ]);
    expect(terminal).toContain("Bash(*kodel* gate*)");
    expect(terminal).toContain("Bash(*kodel.js* agent stop*)");
    for (const self of [SELF, { ...SELF, stateDir: "/home/u/state" }, odd]) {
      expect(waitCommandProblem(self, terminal)).toBeUndefined();
      expect(waitCommandProblem(self, print)).toContain("wait r_*");
    }
    // A root whose spelling reads as a person's command would be refused to the worker: said beforehand.
    const trips = waitCommandProblem({ ...SELF, root: "/work/kodel resume/proj" }, terminal);
    expect(trips).toContain("Bash(*kodel* resume*)");
    expect(trips).toContain("is refused by the agent's own deny rule");
    expect(
      waitCommandProblem({ ...SELF, root: "/w", stateDir: "/s/kodel gate" }, terminal),
    ).toContain("gate*");
    // and a path that holds the place of the run cannot be spelled at all
    expect(waitCommandProblem({ ...SELF, root: "/work/{run}/proj" }, terminal)).toContain("{run}");
  });

  test("t45_wait_timeout_is_the_sessions", () => {
    // One constant: the session of a terminal worker and the command it watches its run with end together.
    expect(WORKER_TERMINAL_TIMEOUT_MS).toBe(7 * 24 * 3_600_000);
    expect(
      workerWaitCommand(SELF).endsWith(` --timeout ${WORKER_TERMINAL_TIMEOUT_MS / 1000}`),
    ).toBe(true);
    expect(WORKER_TERMINAL_TIMEOUT_MS / 1000).toBe(604_800);
    // a session may be that long
    expect(
      validateSpec({ argv: ["claude"], cwd: ROOT, timeoutMs: WORKER_TERMINAL_TIMEOUT_MS }),
    ).toBeUndefined();
  });
});

const WORKTREE = "/proj/.kodel/worktrees/x";
const enginesOf =
  (worker: "terminal" | "print" | undefined, more: Record<string, unknown> = {}) =>
  async (): Promise<UnattendedEngines> => ({
    ok: true,
    engines: { claude: { ...(worker === undefined ? {} : { worker }), ...more } },
  });
const PTY_OK = () => ({ ok: true as const });
const NO_PTY: [string, string][] = [
  [
    "bun",
    "a terminal session cannot run under Bun: use the built kodel on Node (`bun run build`, then `node packages/cli/dist/kodel.js`)",
  ],
  ["package missing", "the optional package @lydell/node-pty is not installed: install it"],
  [
    "no binary",
    "@lydell/node-pty has no binary package installed for this platform (@lydell/node-pty-linux-x64)",
  ],
];

/** A launcher whose profile says `worker: terminal` (or what `worker` says) where a terminal can run. */
const terminalDeps = (
  adapter: ScriptedSessionAdapter,
  over: Partial<SessionLauncherDeps> = {},
  worker: "terminal" | "print" | undefined = "terminal",
) => deps(adapter, { engines: enginesOf(worker), ptyProbe: PTY_OK, ...over });

/** The scripted adapter with the real one's rule for names: a name is taken once. */
class NamedAdapter extends ScriptedSessionAdapter {
  private readonly taken = new Set<string>();
  override async start(spec: Parameters<ScriptedSessionAdapter["start"]>[0]) {
    const name = spec.name?.toLowerCase();
    if (name !== undefined) {
      if (this.taken.has(name)) throw new SessionError("NAME_TAKEN", `the name ${name} is taken`);
      this.taken.add(name);
    }
    return super.start(spec);
  }
}

/** The scripted adapter, counting what is typed into a session. */
class TypingAdapter extends ScriptedSessionAdapter {
  typed = 0;
  async send(): Promise<{ bytes: number }> {
    this.typed += 1;
    return { bytes: 0 };
  }
  async attachable(id: string) {
    const live = this.sessions.get(id)?.status.state === "running";
    return live ? { ok: true as const } : { ok: false as const, reason: "it does not run" };
  }
}

/** `kodel agent start` in the test's project, at a terminal, with the launcher the test gives. */
async function agentStart(agent: NonNullable<CliEnv["agent"]>, ...args: string[]) {
  let out = "";
  let err = "";
  const code = await runCli(["--root", dir, "agent", "start", ...args], {
    cwd: dir,
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    interactive: true,
    environment: { PATH: "/usr/bin", HOME: "/home/u" },
    confirm: async () => true,
    select: async () => [],
    ptyProbe: PTY_OK,
    agent: { engines: async () => ({ state: "committed", engines: {} }), ...agent },
  });
  return { code, out, err };
}

describe("t45 the launcher on the profile", () => {
  test("t45_worker_terminal_spec", async () => {
    const adapter = new ScriptedSessionAdapter();
    let reads = 0;
    const engines = async () => {
      reads += 1;
      return enginesOf("terminal")();
    };
    const launcher = createSessionWorkerLauncher(terminalDeps(adapter, { engines }));
    const { name } = await launcher.start({ runId: RUN, workdir: WORKTREE, title: "Add a flag" });
    // The block is read once for a start (the caller holds the start lock).
    expect(reads).toBe(1);
    expect(name).toBe(`kw-${RUN}`);
    const spec = adapter.specs[0];
    if (!spec) throw new Error("no spec");
    const terminal = workerDenylist(ROOT, BASE, { terminal: true });
    const self = {
      exec: "/usr/local/bin/node",
      args: ["/opt/kodel/dist/kodel.js"],
      root: ROOT,
      stateDir: "/home/u/state",
    };
    expect(spec).toEqual({
      argv: terminalWorkerArgv({
        prompt: workerPrompt(RUN, "Add a flag", WORKTREE),
        mcpConfig: workerMcpConfig({ ...self, waitCommand: workerWaitCommand(self) }),
        allowed: workerAllowlist(SERVED),
        denied: terminal,
        sessionId: UUID,
      }),
      cwd: WORKTREE,
      name: `kw-${RUN}`,
      origin: "cli",
      timeoutMs: WORKER_TERMINAL_TIMEOUT_MS,
      inheritEnv: false,
      env: workerEnv(ENV),
      mode: "pty",
      size: { cols: 120, rows: 40 },
      agent: { engine: "claude", session: UUID },
    });
    expect(validateSpec(spec)).toBeUndefined();
    const argv = spec.argv ?? [];
    expect(argv).not.toContain("-p");
    expect(argv.at(-2)).toBe("--");
    // Its server spells the command it watches its run with; the shell that runs it has no KODEL_* of its own.
    const mcp = JSON.parse(argv[argv.indexOf("--mcp-config") + 1] ?? "{}") as {
      mcpServers: { kodel: { args: string[] } };
    };
    const args = mcp.mcpServers.kodel.args;
    expect(args).not.toContain("--no-wait-hint");
    expect(args[args.indexOf("--wait-command") + 1]).toBe(workerWaitCommand(self));
    expect(Object.keys(spec.env ?? {}).filter((key) => key.startsWith("KODEL_"))).toEqual([]);
    expect(terminal).not.toContain("Bash(*kodel* wait r_*)");
    // The starter's own terminal gives the first size when it has one.
    const sized = new ScriptedSessionAdapter();
    await createSessionWorkerLauncher(
      terminalDeps(sized, { terminalSize: () => ({ cols: 200, rows: 50 }) }),
    ).start({ runId: RUN, workdir: WORKTREE, title: "t" });
    expect(sized.specs[0]?.size).toEqual({ cols: 200, rows: 50 });
    // The person's committed flags are beside kodel's own, and the built argv is read back before the start.
    const flagged = new ScriptedSessionAdapter();
    await createSessionWorkerLauncher(
      terminalDeps(flagged, {
        engines: enginesOf("terminal", { terminal: { command: ["claude", "--model", "opus"] } }),
      }),
    ).start({ runId: RUN, workdir: WORKTREE, title: "t" });
    const withFlags = flagged.specs[0]?.argv ?? [];
    const at = withFlags.indexOf("--model");
    expect(withFlags.slice(at, at + 2)).toEqual(["--model", "opus"]);
    const refused = new ScriptedSessionAdapter();
    await expect(
      createSessionWorkerLauncher(
        terminalDeps(refused, {
          engines: enginesOf("terminal", { terminal: { command: ["claude", "--add-dir", "/"] } }),
        }),
      ).start({ runId: RUN, workdir: WORKTREE, title: "t" }),
    ).rejects.toThrow("terminal.command");
    expect(refused.starts).toBe(0);
  });

  test("t45_worker_print_spec_is_todays", async () => {
    const adapter = new ScriptedSessionAdapter();
    const launcher = createSessionWorkerLauncher(terminalDeps(adapter, {}, "print"));
    await launcher.start({ runId: RUN, workdir: WORKTREE, title: "Add a flag" });
    const { agent, ...spec } = adapter.specs[0] ?? { agent: undefined };
    // Byte for byte the spec of the `claude -p` worker before T-45; only the `agent` record is new.
    expect(spec).toEqual({
      argv: [
        "claude",
        "-p",
        workerPrompt(RUN, "Add a flag", WORKTREE),
        "--output-format",
        "stream-json",
        "--verbose",
        "--session-id",
        UUID,
        "--mcp-config",
        JSON.stringify({
          mcpServers: {
            kodel: {
              command: "/usr/local/bin/node",
              args: [
                "/opt/kodel/dist/kodel.js",
                "--root",
                ROOT,
                "mcp",
                "--no-decisions",
                "--no-wait-hint",
              ],
              env: { KODEL_STATE_DIR: "/home/u/state" },
            },
          },
        }),
        "--strict-mcp-config",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        workerAllowlist(SERVED).join(","),
        "--disallowedTools",
        workerDenylist(ROOT, BASE).join(","),
      ],
      cwd: WORKTREE,
      name: `kw-${RUN}`,
      origin: "cli",
      timeoutMs: 12 * 3_600_000,
      inheritEnv: false,
      env: workerEnv(ENV),
    });
    expect(agent).toEqual({ engine: "claude", session: UUID });
    expect(workerDenylist(ROOT, BASE)).toContain("Bash(*kodel* wait r_*)");
  });

  test("t45_print_start_writes_the_agent_record", async () => {
    // The starter writes `agent.json` from `spec.agent` (`tA_agent_record_is_written_once`): a print
    // start gives it the engine and the chosen id like a terminal one, and so does a resume.
    const adapter = new ScriptedSessionAdapter();
    const launcher = createSessionWorkerLauncher(terminalDeps(adapter, {}, "print"));
    await launcher.start({ runId: RUN, workdir: WORKTREE, title: "t" });
    const first = adapter.only();
    expect(first.spec.agent).toEqual({ engine: "claude", session: UUID });
    expect(first.spec.mode).toBeUndefined();
    adapter.finish(first.id, { state: "exited", exitCode: 0, since: 9_000 });
    await launcher.resume({ runId: RUN, workdir: WORKTREE, sessionId: UUID, decision: DECISION });
    expect(adapter.only(`kw-${RUN}-d17`).spec.agent).toEqual({
      engine: "claude",
      session: UUID,
      resumes: first.id,
    });
    // Neither holds a prompt or an argv.
    expect(JSON.stringify(first.spec.agent)).not.toContain("Kodel run");
  });

  test("t45_terminal_that_cannot_run_is_refused", async () => {
    for (const [what, reason] of NO_PTY) {
      const adapter = new ScriptedSessionAdapter();
      const launcher = createSessionWorkerLauncher(
        terminalDeps(adapter, { ptyProbe: () => ({ ok: false, reason }) }),
      );
      const check = await launcher.preflight({ dialog: false, taskLink: true, pipelines: 1 });
      expect(check.ok, what).toBe(false);
      expect(check.ok ? "" : check.reason).toContain(reason);
      // A start that skipped the preflight is refused the same way, and nothing reaches the adapter.
      await expect(launcher.start({ runId: RUN, workdir: WORKTREE, title: "t" })).rejects.toThrow(
        reason,
      );
      expect(adapter.starts, what).toBe(0);
      // The TUI asks before it makes a run: no run, no agent.
      const h = host();
      const opts = await options(h, launcher);
      const key = await seedTask(`Task ${what}`);
      const asked = await opts.prepareStart?.(key);
      expect(asked?.ok, what).toBe(false);
      expect(asked?.ok === false ? asked.message : "").toContain(reason);
      expect(await h.runSummaries()).toEqual([]);
    }
    // The daemon asks the same preflight and uses no attempt: `t44_environment_no_claude_is_not_an_attempt`.
  });

  test("t45_no_mechanism_is_switched_by_itself", async () => {
    // `terminal` where no terminal runs: no print worker instead.
    const none = new ScriptedSessionAdapter();
    await expect(
      createSessionWorkerLauncher(
        terminalDeps(none, { ptyProbe: () => ({ ok: false, reason: "no terminal here" }) }),
      ).start({ runId: RUN, workdir: WORKTREE, title: "t" }),
    ).rejects.toThrow("no terminal here");
    expect(none.specs).toEqual([]);
    // `print` where a terminal runs: no terminal worker instead, and the probe is not even asked.
    const print = new ScriptedSessionAdapter();
    let asked = 0;
    await createSessionWorkerLauncher(
      terminalDeps(
        print,
        {
          ptyProbe: () => {
            asked += 1;
            return { ok: true };
          },
        },
        "print",
      ),
    ).start({ runId: RUN, workdir: WORKTREE, title: "t" });
    expect(print.specs.map((spec) => spec.mode)).toEqual([undefined]);
    expect(print.specs[0]?.argv?.[1]).toBe("-p");
    expect(asked).toBe(0);
    // A terminal start that fails is not tried again another way.
    const failing = new ScriptedSessionAdapter();
    failing.failStart = { code: "HOLDER_BOOT_FAILED" };
    await expect(
      createSessionWorkerLauncher(terminalDeps(failing)).start({
        runId: RUN,
        workdir: WORKTREE,
        title: "t",
      }),
    ).rejects.toThrow();
    expect(failing.specs.map((spec) => spec.mode)).toEqual(["pty"]);
  });

  test("t45_holder_failure_is_a_failed_start", async () => {
    // The holder cannot open the terminal: the start fails as any launch does, with the session's own error.
    const adapter = new ScriptedSessionAdapter();
    adapter.failStart = { code: "HOLDER_BOOT_FAILED" };
    const launcher = createSessionWorkerLauncher(terminalDeps(adapter));
    const failure = await launcher
      .start({ runId: RUN, workdir: WORKTREE, title: "t" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionError);
    expect((failure as SessionError).code).toBe("HOLDER_BOOT_FAILED");
    expect(adapter.starts).toBe(1);
    expect(adapter.sessions.size).toBe(0);
    // Through the TUI's start the run is kept and said to have no agent (the daemon notes `not_started`:
    // `t44_failed_launch_is_noted_not_retried`).
    const key = await seedTask();
    const started = await (await options(host(), launcher)).startTask?.(key, "one");
    expect(started?.ok).toBe(false);
    expect(started?.message).toContain("was made but no agent was started");
    expect(adapter.specs.every((spec) => spec.mode === "pty")).toBe(true);
  });

  test("t45_refusal_spells_the_migration_line", async () => {
    expect(WORKER_PRINT_MIGRATION_LINE).toBe("engines: { claude: { worker: print } }");
    const reason = NO_PTY[0]?.[1] ?? "";
    const probe = () => ({ ok: false as const, reason });
    const adapter = new ScriptedSessionAdapter();
    const refused = await createSessionWorkerLauncher(
      terminalDeps(adapter, { ptyProbe: probe }),
    ).preflight({ dialog: false, taskLink: true, pipelines: 1 });
    expect(refused.ok ? "" : refused.reason).toBe(
      `${reason}; to start agents without a terminal, commit ${WORKER_PRINT_MIGRATION_LINE} in .kodel/config.yaml`,
    );
    // With that line committed the same machine starts today's worker.
    const launcher = createSessionWorkerLauncher(
      terminalDeps(adapter, { ptyProbe: probe }, "print"),
    );
    expect(await launcher.preflight({ dialog: false, taskLink: true, pipelines: 1 })).toEqual({
      ok: true,
    });
    await launcher.start({ runId: RUN, workdir: WORKTREE, title: "t" });
    expect(adapter.specs[0]?.argv?.slice(0, 2)).toEqual(["claude", "-p"]);
  });

  test("t45_dialog_still_refuses_every_worker", async () => {
    for (const worker of ["terminal", "print"] as const) {
      const adapter = new ScriptedSessionAdapter();
      const launcher = createSessionWorkerLauncher(terminalDeps(adapter, {}, worker));
      const check = await launcher.preflight({ dialog: true, taskLink: true, pipelines: 1 });
      expect(check.ok ? "" : check.reason).toContain("decisions.dialog");
      // also for a run with no task (`kodel agent start --pipeline`)
      const noTask = await launcher.preflight({
        dialog: true,
        taskLink: false,
        pipelines: 1,
        noTask: true,
      });
      expect(noTask.ok).toBe(false);
    }
    // A run with no task skips only the tracker check.
    const adapter = new ScriptedSessionAdapter();
    const launcher = createSessionWorkerLauncher(terminalDeps(adapter));
    const input = { dialog: false, taskLink: false, pipelines: 1 };
    expect((await launcher.preflight(input)).ok).toBe(false);
    expect((await launcher.preflight({ ...input, noTask: true })).ok).toBe(true);

    // The command: `kodel agent start --pipeline` asks that same preflight, with what the config says.
    writeFileSync(join(dir, ".kodel", "config.yaml"), `${CONFIG}decisions:\n  dialog: true\n`);
    for (const worker of ["terminal", "print"] as const) {
      const sessions = new ScriptedSessionAdapter();
      const refused = await agentStart(
        { launcher: async () => createSessionWorkerLauncher(terminalDeps(sessions, {}, worker)) },
        "--pipeline",
        "one",
        "Add a flag",
      );
      expect(refused.code, worker).toBe(1);
      expect(refused.err, worker).toContain("decisions.dialog");
      expect(sessions.starts, worker).toBe(0);
    }
    // No run was made for a start that was refused.
    expect(await host().runSummaries()).toEqual([]);
  });

  test("t45_every_starter_builds_the_same_spec", async () => {
    // The TUI's start, with the launcher it was given, and what it asks of it.
    const tui = new ScriptedSessionAdapter();
    const real = createSessionWorkerLauncher(terminalDeps(tui));
    const asked: StartInput[] = [];
    const recording: WorkerLauncher = {
      ...real,
      start: (input) => {
        asked.push(input);
        return real.start(input);
      },
    };
    const key = await seedTask("Add a flag");
    const started = await (await options(host(), recording)).startTask?.(key, "one");
    expect(started?.ok).toBe(true);
    const [input] = asked;
    if (!input) throw new Error("the TUI asked for no start");
    // The daemon's port over the same launcher code gives the adapter the same spec for that run.
    const daemon = new ScriptedSessionAdapter();
    await serveLauncherOf(createSessionWorkerLauncher(terminalDeps(daemon))).start(input);
    expect(daemon.specs).toEqual(tui.specs);
    // Each takes the `claude` profile by name from the one table.
    const profile = agentProfile("claude");
    expect(tui.specs[0]?.agent?.engine).toBe("claude");
    expect(tui.specs[0]?.argv?.[0]).toBe(profile?.program ?? "");
    expect(AGENT_PROFILES.claude).toBe(profile as AgentProfile);
    // `kodel agent start --pipeline` is the third starter: the command gives its launcher (the same
    // code) a run it made itself, and what reaches the adapter is what the daemon's port builds for
    // that very run.
    const third = new ScriptedSessionAdapter();
    const thirdAsked: StartInput[] = [];
    const started3 = await agentStart(
      {
        launcher: async (engines) => {
          const launcher = createSessionWorkerLauncher(
            terminalDeps(third, engines === undefined ? {} : { engines }),
          );
          return {
            ...launcher,
            start: (startInput) => {
              thirdAsked.push(startInput);
              return launcher.start(startInput);
            },
          };
        },
        engines: async () => ({ state: "committed", engines: { claude: { worker: "terminal" } } }),
      },
      "--pipeline",
      "one",
      "--bg",
      "Add a switch",
    );
    expect(started3.code, started3.err).toBe(0);
    const [input3] = thirdAsked;
    if (!input3) throw new Error("agent start asked for no start");
    expect(input3.runId).not.toBe(input.runId);
    const daemon3 = new ScriptedSessionAdapter();
    await serveLauncherOf(createSessionWorkerLauncher(terminalDeps(daemon3))).start(input3);
    expect(third.specs.length).toBe(1);
    expect(third.specs).toEqual(daemon3.specs);
    expect(third.specs[0]?.agent?.engine).toBe("claude");
    expect(third.specs[0]?.name).toBe(workerNameOf(input3.runId));
    // The three differ only in what names the run: the same spec once the run's id is taken out.
    const shape = (spec: (typeof tui.specs)[number] | undefined, of: StartInput) =>
      JSON.parse(
        JSON.stringify(spec).replaceAll(of.runId, "<run>").replaceAll(of.title, "<title>"),
      ) as unknown;
    expect(input3.title).toBe("Add a switch");
    expect(shape(third.specs[0], input3)).toEqual(shape(tui.specs[0], input));
  });

  test("t45_one_caller_starts_workers", () => {
    // A worker's name is `workerNameOf(...)`; only the session launcher gives one to `adapter.start`.
    const roots = [join(import.meta.dir, "../src"), join(import.meta.dir, "../../local/src")];
    const files = roots.flatMap((root) =>
      (readdirSync(root, { recursive: true }) as string[])
        .filter((file) => file.endsWith(".ts"))
        .map((file) => join(root, file)),
    );
    const starters = files.filter((file) => {
      const text = readFileSync(file, "utf8");
      return /adapter\.start\(/.test(text) && /workerNameOf\(|name: ["'`]kw-/.test(text);
    });
    expect(starters.map((file) => file.split("/").at(-1))).toEqual(["worker-launcher-session.ts"]);
    // And the factory that builds that launcher is the one `tui` and `serve` open.
    const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8");
    expect(cli.match(/createSessionWorkerLauncher/g)).toBeNull();
  });

  test("t45_engine_choice_is_not_built", async () => {
    // `serve.start[].engine` is an unknown key: which engine a worker uses is the follow-up task's.
    const store = join(dir, ".kodel");
    writeFileSync(
      join(store, "config.yaml"),
      `${CONFIG}serve:\n  start:\n    - pipeline: one\n      engine: claude\n`,
    );
    await expect(loadConfig(store)).rejects.toThrow(/engine/);
    // `kodel agent start --engine` is an unknown flag, and nothing is started for it.
    writeFileSync(join(store, "config.yaml"), CONFIG);
    const adapter = new ScriptedSessionAdapter();
    for (const args of [
      ["--engine", "claude", "hello"],
      ["--pipeline", "one", "--engine", "claude", "hello"],
    ]) {
      const refused = await agentStart(
        { launcher: async () => createSessionWorkerLauncher(terminalDeps(adapter)) },
        ...args,
      );
      expect(refused.code, args.join(" ")).toBe(1);
      expect(refused.err, args.join(" ")).toContain("unknown option '--engine'");
    }
    expect(adapter.starts).toBe(0);
    expect(await host().runSummaries()).toEqual([]);
    // A start names a run and no engine.
    const input: StartInput = { runId: RUN, workdir: WORKTREE, title: "t" };
    expect(Object.keys(input)).toEqual(["runId", "workdir", "title"]);
  });

  test("t45_trust_is_probed_for_the_worktrees_folder", async () => {
    const worktrees = "/proj/.kodel/worktrees";
    const reads: string[] = [];
    const answer = async (file: string | undefined, worker: "terminal" | "print" = "terminal") => {
      const adapter = new ScriptedSessionAdapter();
      const launcher = createSessionWorkerLauncher(
        terminalDeps(
          adapter,
          {
            readText: async (path) => {
              reads.push(path);
              return file;
            },
          },
          worker,
        ),
      );
      const check = await launcher.preflight({
        dialog: false,
        taskLink: true,
        pipelines: 1,
        worktreesDir: worktrees,
        unattended: true,
      });
      // Before any run exists: nothing was started.
      expect(adapter.starts).toBe(0);
      return check;
    };
    const trusted = JSON.stringify({ projects: { "/proj": { hasTrustDialogAccepted: true } } });
    // Trust of a folder above is inherited; the file is claude's own, in its config folder.
    expect(await answer(trusted)).toEqual({ ok: true });
    expect(reads).toEqual(["/home/u/.claude/.claude.json"]);
    expect(await trustProbe(worktrees, ENV, async () => trusted)).toBe("trusted");
    expect(await trustProbe("/proj", ENV, async () => trusted)).toBe("trusted");
    expect(await trustProbe("/projects", ENV, async () => trusted)).toBe("will_ask");
    const elsewhere = JSON.stringify({
      projects: { "/other": { hasTrustDialogAccepted: true }, "/proj": {} },
    });
    expect(await trustProbe(worktrees, ENV, async () => elsewhere)).toBe("will_ask");
    // Another product's file: anything that is not the shape known is "unknown", never a refusal.
    for (const odd of [undefined, "not json", "[]", JSON.stringify({ projects: 3 })]) {
      expect(await trustProbe(worktrees, ENV, async () => odd)).toBe("unknown");
    }
    expect(await trustProbe(worktrees, { PATH: "/bin" }, async () => trusted)).toBe("unknown");
    // A print worker is asked no such question: the file is not read for it.
    reads.length = 0;
    expect(await answer(JSON.stringify({ projects: {} }), "print")).toEqual({ ok: true });
    expect(reads).toEqual([]);
  });

  test("t45_preflight_blocks_an_unattended_start_when_trust_asks", async () => {
    const worktrees = "/proj/.kodel/worktrees";
    const check = (file: string | undefined, unattended: boolean) =>
      createSessionWorkerLauncher(
        terminalDeps(new ScriptedSessionAdapter(), { readText: async () => file }),
      ).preflight({
        dialog: false,
        taskLink: true,
        pipelines: 1,
        worktreesDir: worktrees,
        unattended,
      });
    const asks = JSON.stringify({ projects: { "/elsewhere": { hasTrustDialogAccepted: true } } });
    // "Will ask" blocks a start nobody watches.
    const blocked = await check(asks, true);
    expect(blocked.ok).toBe(false);
    expect(blocked.ok ? "" : blocked.reason).toContain(
      `claude in ${worktrees} will first ask whether the folder is trusted`,
    );
    // A person's start goes on, with a notice.
    const person = await check(asks, false);
    expect(person.ok).toBe(true);
    expect(person.ok ? person.note : "").toContain("open the agent and answer it");
    // Unknown lets the daemon's start go, and says so (the daemon logs it once).
    const unknown = await check(undefined, true);
    expect(unknown.ok).toBe(true);
    expect(unknown.ok ? unknown.note : "").toContain("is not known");
    expect(await check(undefined, false)).toEqual({ ok: true });
  });

  test("t45_engines_as_committed_refuse_a_start", async () => {
    const refusing = async (): Promise<UnattendedEngines> => ({
      ok: false,
      reason:
        "engines is used only as committed: commit .kodel/config.yaml or put the block back as it was",
    });
    const adapter = new ScriptedSessionAdapter();
    const launcher = createSessionWorkerLauncher(terminalDeps(adapter, { engines: refusing }));
    const check = await launcher.preflight({ dialog: false, taskLink: true, pipelines: 1 });
    expect(check.ok ? "" : check.reason).toContain("engines is used only as committed");
    await expect(launcher.start({ runId: RUN, workdir: WORKTREE, title: "t" })).rejects.toThrow(
      "engines is used only as committed",
    );
    expect(adapter.starts).toBe(0);
    // A reader that throws (a config that does not load) refuses too.
    const broken = createSessionWorkerLauncher(
      terminalDeps(adapter, {
        engines: async () => {
          throw new Error("engines.codex: unknown key");
        },
      }),
    );
    expect((await broken.preflight({ dialog: false, taskLink: true, pipelines: 1 })).ok).toBe(
      false,
    );
    // The one line about a config git does not track comes back as a note.
    const noted = createSessionWorkerLauncher(
      terminalDeps(adapter, {
        engines: async () => ({
          ok: true,
          engines: { claude: { worker: "print" } },
          note: "taken from a .kodel/config.yaml that git does not track",
        }),
      }),
    );
    expect(await noted.preflight({ dialog: false, taskLink: true, pipelines: 1 })).toEqual({
      ok: true,
      note: "taken from a .kodel/config.yaml that git does not track",
    });
  });
});

describe("t45 the default mechanism", () => {
  test("t45_default_is_terminal_only_after_the_rule", async () => {
    // The serve rule knows a worker that stays alive at a wait: it holds a run place and no worker
    // place there, and its session ending at the wait is no death.
    const waiting = {
      runId: RUN,
      status: "running" as const,
      canNote: true,
      waitsForPerson: true,
      idleAtWait: true,
      noted: [],
      worker: {
        id: "a_000000001_fake",
        name: `kw-${RUN}`,
        state: "running" as const,
        label: "running",
        started: 0,
        resumed: [],
        resumes: 0,
        terminal: true,
      },
    };
    expect(servePlaces([waiting])).toEqual({ workers: 0, runs: [RUN] });
    expect(
      resumeVerdict(
        { runId: RUN, status: "running", waitsForPerson: true },
        { ...waiting.worker, state: "lost", since: 5 },
        { refuseMoved: true },
      ),
    ).toEqual({ kind: "no", why: "waiting_person" });
    // So the absent key means `terminal`: with no `engines` block at all, and with a `claude` profile
    // that names no `worker`.
    expect(DEFAULT_WORKER_MECHANISM).toBe("terminal");
    for (const engines of [
      undefined,
      async (): Promise<UnattendedEngines> => ({ ok: true, engines: {} }),
      enginesOf(undefined),
    ]) {
      const adapter = new ScriptedSessionAdapter();
      const launcher = createSessionWorkerLauncher(
        deps(adapter, { engines, ptyProbe: PTY_OK } as Partial<SessionLauncherDeps>),
      );
      await launcher.start({ runId: RUN, workdir: WORKTREE, title: "t" });
      const spec = adapter.specs[0];
      expect(spec?.mode).toBe("pty");
      expect(spec?.timeoutMs).toBe(WORKER_TERMINAL_TIMEOUT_MS);
      expect(spec?.argv).not.toContain("-p");
      expect(spec?.agent).toEqual({ engine: "claude", session: UUID });
    }
    // Where no terminal runs (here, under Bun) the start is refused and spells the line to commit;
    // with that line the worker is today's.
    const refused = new ScriptedSessionAdapter();
    const real = createSessionWorkerLauncher(
      deps(refused, { engines: undefined } as Partial<SessionLauncherDeps>),
    );
    const check = await real.preflight({ dialog: false, taskLink: true, pipelines: 1 });
    expect(check.ok ? "" : check.reason).toContain("a terminal session cannot run under Bun");
    expect(check.ok ? "" : check.reason).toContain(WORKER_PRINT_MIGRATION_LINE);
    await expect(real.start({ runId: RUN, workdir: WORKTREE, title: "t" })).rejects.toThrow(
      WORKER_PRINT_MIGRATION_LINE,
    );
    expect(refused.starts).toBe(0);
    const print = createSessionWorkerLauncher(deps(refused, { engines: enginesOf("print") }));
    await print.start({ runId: RUN, workdir: WORKTREE, title: "t" });
    expect(refused.specs[0]?.argv?.slice(0, 2)).toEqual(["claude", "-p"]);
  });
});

describe("t45 the id of a worker's conversation", () => {
  test("t45_session_id_is_the_chosen_one", async () => {
    // A terminal argv ends with the prompt, and a title may spell a flag: the id is the record's.
    const adapter = new ScriptedSessionAdapter();
    const launcher = createSessionWorkerLauncher(terminalDeps(adapter));
    await launcher.start({ runId: RUN, workdir: WORKTREE, title: `fix --session-id ${OTHER}` });
    const first = adapter.only();
    expect(first.spec.argv?.at(-1)).toContain(`--session-id ${OTHER}`);
    expect((await launcher.statuses([RUN])).get(RUN)).toMatchObject({
      sessionId: UUID,
      terminal: true,
    });
    adapter.finish(first.id, { state: "exited", exitCode: 0, since: 9_000 });
    await launcher.resume({ runId: RUN, workdir: WORKTREE, sessionId: UUID, decision: DECISION });
    const resumed = adapter.only(`kw-${RUN}-d17`).spec.argv ?? [];
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe(UUID);
    expect((await launcher.statuses([RUN])).get(RUN)?.sessionId).toBe(UUID);
    // Without the record the argv of a terminal session would name the title's id: it is never read.
    const entry = (more: Partial<SessionListEntry>): SessionListEntry => ({
      id: "a_000000001_fake",
      name: `kw-${RUN}`,
      command: (first.spec.argv ?? []).join(" "),
      status: { state: "exited" },
      mode: "pty",
      ...more,
    });
    expect(workerStatusOf([entry({ agent: { engine: "claude", session: UUID } })])?.sessionId).toBe(
      UUID,
    );
    // A record of another engine names no conversation of this profile.
    expect(
      workerStatusOf([entry({ agent: { engine: "codex", session: OTHER } })])?.sessionId,
    ).toBeUndefined();
    expect(workerStatusOf([entry({ agent: { engine: "claude" } })])?.sessionId).toBeUndefined();
  });

  test("t45_session_id_never_from_the_screen", async () => {
    for (const worker of ["terminal", "print"] as const) {
      const adapter = new ScriptedSessionAdapter();
      const launcher = createSessionWorkerLauncher(terminalDeps(adapter, {}, worker));
      await launcher.start({ runId: RUN, workdir: WORKTREE, title: "t" });
      // What the agent printed names another conversation: nothing reads an id from it.
      adapter.finish(
        adapter.only().id,
        { state: "running" },
        `${INIT(OTHER)}\n${RESULT(OTHER)}\n--session-id ${OTHER}\n--resume ${OTHER}\n`,
      );
      expect((await launcher.statuses([RUN])).get(RUN)?.sessionId, worker).toBe(UUID);
      const progress = await launcher.progress(RUN);
      expect(Object.keys(progress)).toEqual(["lines"]);
      expect((await launcher.statuses([RUN])).get(RUN)?.sessionId, worker).toBe(UUID);
    }
  });

  test("t45_older_record_id_comes_from_its_argv", async () => {
    // A record from before the `agent` record existed: listed without one, its id read from its argv.
    const adapter = new ScriptedSessionAdapter();
    const launcher = createSessionWorkerLauncher(
      terminalDeps(adapter, { exec: fakeExec(adapter, { noAgent: true }) }, "print"),
    );
    await launcher.start({ runId: RUN, workdir: WORKTREE, title: `t --session-id ${OTHER}` });
    const first = adapter.only();
    adapter.finish(first.id, { state: "exited", exitCode: 0, since: 9_000 });
    const starts = adapter.starts;
    expect((await launcher.statuses([RUN])).get(RUN)?.sessionId).toBe(UUID);
    // Reading it writes nothing and starts nothing.
    expect(adapter.starts).toBe(starts);
    // An argv without a valid id names none, and the rule says `no_session_id`.
    const row = (command: string): SessionListEntry => ({
      id: "a_000000001_fake",
      name: `kw-${RUN}`,
      command,
      status: { state: "exited", exitCode: 0, since: 4_500 },
      mode: "pipes",
    });
    expect(
      workerStatusOf([row("claude -p hello --session-id not-a-uuid")])?.sessionId,
    ).toBeUndefined();
    const none = workerStatusOf([row("claude -p hello")]);
    if (!none) throw new Error("no status");
    expect(none.sessionId).toBeUndefined();
    const journal = [
      { v: 2, seq: 1, ts: 1_000, event: "run_started" },
      { v: 2, seq: 2, ts: 4_000, event: "gate_waiting", node: "g" },
      { v: 2, seq: 3, ts: 5_000, event: "gate_decided", node: "g", decision: "approved" },
    ] as Parameters<typeof decisionOf>[0];
    const verdict = resumeVerdict(
      { runId: RUN, status: "running", waitsForPerson: false, marks: decisionOf(journal) },
      serveWorkerOf({ ...none, started: 0 }),
      { refuseMoved: true },
    );
    expect(verdict).toEqual({ kind: "no", why: "no_session_id" });
  });

  test("t45_inflight_print_worker_is_resumed_after_the_update", async () => {
    // A `claude -p` worker record as a build before T-45 wrote it (no `agent.json`), exited at its gate.
    const fixture = join(
      import.meta.dir,
      "../../../fixtures/session-formats/v1/worker-print-before-t45",
    );
    expect(readdirSync(fixture).sort()).toEqual(["session.json", "status.json"]);
    const stateBase = mkdtempSync(join(tmpdir(), "kodel-worker-old-"));
    made.push(stateBase);
    const place = sessionPlace({ base: stateBase, root: dir });
    const id = "a_0loyw3v28_0000";
    mkdirSync(place.dir, { recursive: true, mode: 0o700 });
    cpSync(fixture, join(place.dir, id), { recursive: true });
    const old = `kw-${RUN}`;
    const stored = new PipesSessionAdapter({
      base: stateBase,
      root: dir,
      holder: { exec: process.execPath, args: ["holder"] },
      intermediate: { exec: process.execPath, args: [] },
    });
    const listed = await stored.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id, name: old, mode: "pipes", status: { state: "exited" } });
    expect(listed[0]?.agent).toBeUndefined();
    // The launcher reads it through `agent ls --json`; the start of the resume goes to the scripted adapter.
    const adapter = new ScriptedSessionAdapter();
    const launcher = createSessionWorkerLauncher(
      terminalDeps(
        adapter,
        { exec: async () => ({ stdout: JSON.stringify(listed), stderr: "", code: 0 }) },
        "print",
      ),
    );
    const status = (await launcher.statuses([RUN])).get(RUN);
    // The id is the last `--session-id` of its argv, not the one the task's title spells.
    expect(status).toMatchObject({ name: old, state: "exited", sessionId: UUID, resumes: 0 });
    expect(status?.terminal).toBeUndefined();
    if (!status) throw new Error("no status");
    // Decided after the update: resumed, once, with that id.
    const journal = [
      { v: 2, seq: 1, ts: 1_700_000_001_000, event: "run_started" },
      { v: 2, seq: 2, ts: 1_700_000_050_000, event: "gate_waiting", node: "g" },
    ] as Parameters<typeof decisionOf>[0];
    const view = serveWorkerOf(status);
    const run = (records: typeof journal, waitsForPerson: boolean) => ({
      runId: RUN,
      status: "running" as const,
      waitsForPerson,
      marks: decisionOf(records),
    });
    // Until the decision it keeps its place and is not a worker without an id.
    expect(resumeVerdict(run(journal, true), view, { refuseMoved: true })).toEqual({
      kind: "no",
      why: "waiting_person",
    });
    const decided = [
      ...journal,
      {
        v: 2,
        seq: 3,
        ts: 1_700_000_900_000,
        event: "gate_decided",
        node: "g",
        decision: "approved",
      },
    ] as typeof journal;
    const verdict = resumeVerdict(run(decided, false), view, { refuseMoved: true });
    expect(verdict.kind).toBe("resume");
    if (verdict.kind !== "resume") throw new Error("no resume");
    await launcher.resume({
      runId: RUN,
      workdir: WORKTREE,
      sessionId: status.sessionId ?? "",
      decision: verdict.decision,
    });
    expect(adapter.starts).toBe(1);
    const argv = adapter.specs[0]?.argv ?? [];
    expect(argv[argv.indexOf("--resume") + 1]).toBe(UUID);
    expect(adapter.specs[0]?.name).toBe(`kw-${RUN}-d3`);
    expect(adapter.specs[0]?.agent).toEqual({ engine: "claude", session: UUID, resumes: id });
    // Nothing was written into the old record's folder.
    expect(readdirSync(join(place.dir, id)).sort()).toEqual(["session.json", "status.json"]);
  });
});

describe("t45 one live worker a run", () => {
  test("t45_one_live_worker_per_run_across_modes", async () => {
    // A print worker lives; the setting becomes `terminal`: no second agent for the run, by its name.
    const adapter = new NamedAdapter();
    const print = createSessionWorkerLauncher(terminalDeps(adapter, {}, "print"));
    const terminal = createSessionWorkerLauncher(terminalDeps(adapter));
    await print.start({ runId: RUN, workdir: WORKTREE, title: "t" });
    const second = await terminal
      .start({ runId: RUN, workdir: WORKTREE, title: "t" })
      .catch((error: unknown) => error);
    expect((second as SessionError).code).toBe("NAME_TAKEN");
    // A resume while it lives has another name, and is refused all the same.
    const resumed = await terminal
      .resume({ runId: RUN, workdir: WORKTREE, sessionId: UUID, decision: DECISION })
      .catch((error: unknown) => error);
    expect(resumed).toBeInstanceOf(SessionError);
    expect((resumed as SessionError).code).toBe("NAME_TAKEN");
    expect(adapter.sessions.size).toBe(1);
    // A record whose process still runs without a holder is alive too.
    const orphan = createSessionWorkerLauncher(
      terminalDeps(adapter, {
        exec: async () => ({
          stdout: JSON.stringify([
            {
              id: "a_000000001_fake",
              name: `kw-${RUN}`,
              status: { state: "lost", reason: "holder_gone", childAlive: true },
              mode: "pty",
              agent: { engine: "claude", session: UUID },
            },
          ]),
          stderr: "",
          code: 0,
        }),
      }),
    );
    await expect(
      orphan.resume({ runId: RUN, workdir: WORKTREE, sessionId: UUID, decision: DECISION }),
    ).rejects.toThrow("its process still runs without a holder; stop it: kodel agent stop");
    expect(adapter.sessions.size).toBe(1);
  });

  test("t45_tui_and_daemon_resume_one_decision_once", async () => {
    // Two launchers (the TUI's and the daemon's) over one set of records resume one decision.
    const adapter = new NamedAdapter();
    const tui = createSessionWorkerLauncher(terminalDeps(adapter));
    const daemon = serveLauncherOf(createSessionWorkerLauncher(terminalDeps(adapter)));
    await tui.start({ runId: RUN, workdir: WORKTREE, title: "t" });
    adapter.finish(adapter.only().id, { state: "exited", exitCode: 0, since: 9_000 });
    const input = { runId: RUN, workdir: WORKTREE, sessionId: UUID, decision: DECISION };
    const answers = await Promise.allSettled([tui.resume(input), daemon.resume(input)]);
    expect(answers.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    const refused = answers.find((a) => a.status === "rejected") as PromiseRejectedResult;
    expect((refused.reason as SessionError).code).toBe("NAME_TAKEN");
    expect([...adapter.sessions.values()].map((s) => s.name)).toEqual([
      `kw-${RUN}`.toLowerCase(),
      `kw-${RUN}-d17`.toLowerCase(),
    ]);
    // And one after the other: the second reads the records again and finds the first one's session.
    await expect(daemon.resume(input)).rejects.toMatchObject({ code: "NAME_TAKEN" });
  });

  test("t45_resume_stays_in_the_records_mode", async () => {
    // A profile whose conversations do not cross: the resume is in the mode of the record that wrote it.
    const claude = agentProfile("claude") as AgentProfile;
    const profile: AgentProfile = { ...claude, resumeAcrossModes: false };
    for (const [written, setting] of [
      ["print", "terminal"],
      ["terminal", "print"],
    ] as const) {
      const adapter = new ScriptedSessionAdapter();
      const first = createSessionWorkerLauncher(terminalDeps(adapter, { profile }, written));
      await first.start({ runId: RUN, workdir: WORKTREE, title: "t" });
      adapter.finish(adapter.only().id, { state: "exited", exitCode: 0, since: 9_000 });
      const later = createSessionWorkerLauncher(terminalDeps(adapter, { profile }, setting));
      await later.resume({ runId: RUN, workdir: WORKTREE, sessionId: UUID, decision: DECISION });
      expect(adapter.specs[1]?.mode, written).toBe(written === "terminal" ? "pty" : undefined);
    }
  });

  test("t45_resume_across_modes_when_it_continues", async () => {
    // claude continues a conversation across the two (spike criterion 9): the setting's mode is used.
    expect(agentProfile("claude")?.resumeAcrossModes).toBe(true);
    for (const [written, setting] of [
      ["print", "terminal"],
      ["terminal", "print"],
    ] as const) {
      const adapter = new ScriptedSessionAdapter();
      const first = createSessionWorkerLauncher(terminalDeps(adapter, {}, written));
      await first.start({ runId: RUN, workdir: WORKTREE, title: "t" });
      adapter.finish(adapter.only().id, { state: "exited", exitCode: 0, since: 9_000 });
      const later = createSessionWorkerLauncher(terminalDeps(adapter, {}, setting));
      await later.resume({ runId: RUN, workdir: WORKTREE, sessionId: UUID, decision: DECISION });
      const spec = adapter.specs[1];
      expect(spec?.mode, written).toBe(setting === "terminal" ? "pty" : undefined);
      const argv = spec?.argv ?? [];
      expect(argv[argv.indexOf("--resume") + 1]).toBe(UUID);
      expect(argv.includes("-p")).toBe(setting === "print");
    }
  });

  test("t45_resume_refused_makes_no_record", async () => {
    const adapter = new ScriptedSessionAdapter();
    const launcher = createSessionWorkerLauncher(terminalDeps(adapter, {}, "print"));
    await launcher.start({ runId: RUN, workdir: WORKTREE, title: "t" });
    adapter.finish(adapter.only().id, { state: "exited", exitCode: 0, since: 9_000 });
    const input = { runId: RUN, workdir: WORKTREE, sessionId: UUID, decision: DECISION };
    // The mode of the resume cannot run here: refused with the reason, nothing reaches the adapter.
    const noTerminal = createSessionWorkerLauncher(
      terminalDeps(adapter, { ptyProbe: () => ({ ok: false, reason: "no terminal here" }) }),
    );
    await expect(noTerminal.resume(input)).rejects.toThrow("no terminal here");
    // An id the records do not name is not tried.
    await expect(launcher.resume({ ...input, sessionId: OTHER })).rejects.toThrow(
      "the id of the agent's conversation is not known",
    );
    // A run with no record at all.
    await expect(launcher.resume({ ...input, runId: "r_0mw53d7fj_none" })).rejects.toThrow(
      "is gone",
    );
    expect(adapter.starts).toBe(1);
    expect(adapter.sessions.size).toBe(1);
    // The daemon counts each as one failed attempt, three at most: `t44_failed_resume_is_retried_then_given_up`.
  });

  test("t45_nothing_types_into_a_session", async () => {
    const adapter = new TypingAdapter();
    const launcher = createSessionWorkerLauncher(terminalDeps(adapter));
    const port = serveLauncherOf(launcher);
    await launcher.preflight({ dialog: false, taskLink: true, pipelines: 1 });
    await port.start({ runId: RUN, workdir: WORKTREE, title: "t" });
    await port.statuses([RUN]);
    await launcher.progress(RUN);
    await launcher.logs(RUN);
    expect(await launcher.attachable(RUN)).toEqual({ ok: true, id: adapter.only().id });
    await port.finish(RUN);
    await launcher.resume({ runId: RUN, workdir: WORKTREE, sessionId: UUID, decision: DECISION });
    await launcher.stop(RUN);
    expect(adapter.typed).toBe(0);
    // Nothing in the launcher, the factory, the TUI's worker code or the daemon calls `send` at all.
    const files = [
      "../src/worker-launcher.ts",
      "../src/worker-launcher-session.ts",
      "../src/worker-factory.ts",
      "../src/serve-command.ts",
      "../src/tui/worker-start.ts",
      "../src/tui/worker-resume.ts",
      "../src/tui/run.ts",
      "../../local/src/serve/daemon.ts",
    ];
    for (const file of files) {
      expect(readFileSync(join(import.meta.dir, file), "utf8"), file).not.toMatch(/\.send\??\.?\(/);
    }
    // The daemon's port has no call that could: start, resume, finish, statuses and preflight only.
    expect(Object.keys(port).sort()).toEqual([
      "finish",
      "preflight",
      "resume",
      "start",
      "statuses",
    ]);
  });

  test("t45_finish_of_a_stopped_session_is_harmless", async () => {
    const adapter = new ScriptedSessionAdapter();
    const launcher = createSessionWorkerLauncher(terminalDeps(adapter));
    // A run with no record.
    await launcher.finish(RUN);
    await launcher.start({ runId: RUN, workdir: WORKTREE, title: "t" });
    const session = adapter.only();
    await launcher.finish(RUN);
    expect(session.status).toMatchObject({ state: "killed", reason: "stopped" });
    // Again, on a session that is stopped already, and on one that exited by itself.
    await launcher.finish(RUN);
    adapter.finish(session.id, { state: "exited", exitCode: 0 });
    await launcher.finish(RUN);
    expect(session.status.state).toBe("exited");
    // A session that ended between the read and the stop is no error either.
    const racing = new ScriptedSessionAdapter();
    const raced = createSessionWorkerLauncher(terminalDeps(racing));
    await raced.start({ runId: RUN, workdir: WORKTREE, title: "t" });
    racing.stop = async () => {
      throw new SessionError("NOT_RUNNING", "it ended");
    };
    await raced.finish(RUN);
    // `attachable` says why not for a print worker and for a run with none.
    const print = new TypingAdapter();
    const printing = createSessionWorkerLauncher(terminalDeps(print, {}, "print"));
    expect(await printing.attachable(RUN)).toMatchObject({ ok: false });
    await printing.start({ runId: RUN, workdir: WORKTREE, title: "t" });
    const answer = await printing.attachable(RUN);
    expect(answer.ok ? "" : answer.reason).toContain("runs without a terminal (worker: print)");
  });
});
