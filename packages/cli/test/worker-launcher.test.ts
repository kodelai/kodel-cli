/**
 * The launcher of background agents (TASK-9PNS): the claude profile (argv, lists, prompts, environment,
 * the session id), the session-backed launcher over the scripted adapter and a fake `exec`, the start
 * through a real `LocalPipelineHost` with the fake launcher, and the real adapter with a Node script
 * standing for `claude` (skipped where the process table cannot be read, required under
 * `KODEL_REQUIRE_PROCTABLE=1`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalPipelineHost,
  type LocalRun,
  openTaskService,
  ownProcessGroup,
  PipesSessionAdapter,
} from "@kodel-ai/local";
import {
  type JournalRecord,
  KodelError,
  SessionError,
  type SessionListEntry,
  validateSpec,
} from "@kodel-ai/pipeline-core";
import { decisionTools, HISTORY_TOOLS, TOOLS } from "@kodel-ai/pipeline-core/mcp";
import { resumeVerdict, decisionOf as serveDecisionOf } from "@kodel-ai/pipeline-core/serve";
import { ScriptedSessionAdapter } from "../../testkit/src/engine-fakes";
import { AGENT_HUMAN_COMMANDS } from "../src/agent-commands";
import {
  authProbe,
  type Exec,
  resumePrompt,
  sessionIdOf,
  WORKER_DENIED,
  WORKER_TOOLS,
  workerAllowlist,
  workerDenylist,
  workerEnv,
  workerPrompt,
} from "../src/claude-worker";
import { loadSessions } from "../src/tui/load";
import { openTasksForTui } from "../src/tui/tasks-open";
import { initialModel, withWorkers } from "../src/tui/view";
import { decisionOf, resumeOffer } from "../src/tui/worker-resume";
import { createWorkerOptions, taskTextOf } from "../src/tui/worker-start";
import { openWorkerLauncher, serveWorkerOf, workerServedTools } from "../src/worker-factory";
import {
  WORKER_TIMEOUT_MS,
  type WorkerDecision,
  type WorkerLauncher,
  type WorkerStatus,
  workerNameOf,
} from "../src/worker-launcher";
import {
  createSessionWorkerLauncher,
  type SessionLauncherDeps,
  startedOf,
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
  probe: { stdout?: string; throws?: boolean; late?: boolean } = {},
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
      "--role",
      "worker",
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

// ── the worker's set (5M9D) ─────────────────────────────────────────────────

describe("5m9d the launcher and the worker's own server", () => {
  const BAD = `${CONFIG}mcp:\n  roles:\n    worker:\n      add: [pipeline_strat]\n`;
  const NARROW = `${CONFIG}mcp:\n  roles:\n    worker:\n      remove: [pipeline_plan]\n`;
  const setConfig = (text: string) => writeFileSync(join(dir, ".kodel", "config.yaml"), text);
  const allowedOf = (argv: readonly string[] = []) =>
    (argv[argv.indexOf("--allowedTools") + 1] ?? "").split(",");
  const liveSet = (adapter: ScriptedSessionAdapter) =>
    createSessionWorkerLauncher(
      deps(adapter, { root: dir, servedTools: () => workerServedTools(storeRoot()) }),
    );

  test("5m9d_claude_worker_starts_the_worker_role", async () => {
    const adapter = new ScriptedSessionAdapter();
    const launcher = liveSet(adapter);
    await launcher.start({ runId: RUN, workdir: dir, title: "t" });
    adapter.finish(adapter.only().id, { state: "exited", exitCode: 0, since: 9_000 }, "");
    await launcher.resume({ runId: RUN, workdir: dir, sessionId: UUID, decision: DECISION });
    expect(adapter.specs).toHaveLength(2);
    for (const spec of adapter.specs) {
      const argv = spec.argv ?? [];
      const mcp = JSON.parse(argv[argv.indexOf("--mcp-config") + 1] ?? "{}") as {
        mcpServers: { kodel: { args: string[] } };
      };
      const args = mcp.mcpServers.kodel.args;
      expect(args.slice(args.indexOf("mcp"))).toEqual([
        "mcp",
        "--role",
        "worker",
        "--no-decisions",
        "--no-wait-hint",
      ]);
      // The allow-list is the worker's set: no history, no change of a task, no decision.
      const allowed = allowedOf(argv);
      expect(allowed).toContain("mcp__kodel__pipeline_next_step");
      expect(allowed).toContain("mcp__kodel__task_create");
      for (const name of ["history_runs", "task_update", "pipeline_decide_gate", "manager_inbox"]) {
        expect(allowed).not.toContain(`mcp__kodel__${name}`);
      }
    }
  });

  test("5m9d_resume_over_a_changed_set_goes_on", async () => {
    const adapter = new ScriptedSessionAdapter();
    const launcher = liveSet(adapter);
    await launcher.start({ runId: RUN, workdir: dir, title: "t" });
    expect(allowedOf(adapter.specs[0]?.argv)).toContain("mcp__kodel__pipeline_plan");
    adapter.finish(adapter.only().id, { state: "exited", exitCode: 0, since: 9_000 }, "");
    // The person narrows the worker's set while the run waits for them.
    setConfig(NARROW);
    const { name } = await launcher.resume({
      runId: RUN,
      workdir: dir,
      sessionId: UUID,
      decision: DECISION,
    });
    expect(name).toBe(`kw-${RUN}-d17`);
    const argv = adapter.specs[1]?.argv ?? [];
    // The resumed session is allowed what the server serves now, and is told its tools may have changed.
    expect(allowedOf(argv)).not.toContain("mcp__kodel__pipeline_plan");
    expect(allowedOf(argv)).toContain("mcp__kodel__pipeline_next_step");
    expect(argv[2]).toContain("may have changed since this session began");
    expect(argv[2]).toContain(`Continue Kodel run ${RUN}`);
    // Both prompts say what to do when the kodel tools are missing altogether.
    for (const prompt of [workerPrompt(RUN, "t", dir), resumePrompt(RUN, DECISION)]) {
      expect(prompt).toContain("If you have no pipeline_next_step tool");
      expect(prompt).toContain("stop at once");
    }
  });

  test("5m9d_launcher_spawns_no_worker_whose_set_does_not_resolve", async () => {
    const adapter = new ScriptedSessionAdapter();
    const launcher = liveSet(adapter);
    const input = { dialog: false, taskLink: true, pipelines: 1 };
    // A good config: the preflight passes (the daemon keeps that answer for a minute).
    expect(await launcher.preflight(input)).toEqual({ ok: true });
    setConfig(BAD);
    // Within that minute no preflight is asked again: the start and the resume check for themselves.
    const refused = async (work: Promise<unknown>) => {
      const error = await work.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(KodelError);
      expect((error as KodelError).code).toBe("CONFIG_INVALID");
      expect((error as KodelError).message).toContain('"pipeline_strat"');
    };
    await refused(launcher.start({ runId: RUN, workdir: dir, title: "t" }));
    await refused(
      launcher.resume({ runId: RUN, workdir: dir, sessionId: UUID, decision: DECISION }),
    );
    expect(adapter.specs).toEqual([]);
    const preflight = await launcher.preflight(input);
    expect(preflight.ok).toBe(false);
    expect(!preflight.ok && preflight.reason).toContain("the agent's kodel server would not start");
    expect(!preflight.ok && preflight.reason).toContain('"pipeline_strat"');

    // The launcher the CLI builds does not swallow it either: the reason, and nothing spawned.
    const real = await openWorkerLauncher({
      root: dir,
      dataDir: storeRoot(),
      environment: { PATH: "/usr/bin:/bin", HOME: dir, KODEL_STATE_DIR: join(dir, "state") },
      self: { exec: process.execPath, args: [join(import.meta.dir, "../src/main.ts")] },
      platform: "linux",
    });
    const fromCli = await real.preflight(input);
    expect(!fromCli.ok && fromCli.reason).toContain('"pipeline_strat"');
    await refused(real.start({ runId: RUN, workdir: dir, title: "t" }));
    // A tracker that cannot be opened still only drops the task tools, as in the server.
    setConfig("worktree:\n  mode: off\ntasks:\n  enabled: maybe\n");
    const served = await workerServedTools(storeRoot());
    expect(served).toContain("pipeline_start");
    expect(served.some((name) => name.startsWith("task_"))).toBe(false);
  });

  test("5m9d_tui_shows_the_config_refusal", async () => {
    const reason =
      '.kodel/config.yaml: mcp.roles.worker names "pipeline_strat", which is not a tool';
    const refusal = new KodelError("CONFIG_INVALID", reason);
    // At the question: the preflight's reason is what the person reads.
    const asked = new FakeLauncher();
    asked.preflightResult = {
      ok: false,
      reason: `the agent's kodel server would not start: ${reason}`,
    };
    const key = await seedTask();
    const h = host();
    const check = await (await options(h, asked)).prepareStart?.(key);
    expect(check?.ok).toBe(false);
    expect(!check?.ok && check?.message).toContain("pipeline_strat");
    // At the start (the config changed after the question): the run exists, no agent, and why.
    const failing = new FakeLauncher();
    failing.failStart = refusal;
    const opts = await options(h, failing);
    const started = await opts.startTask?.(key, "one");
    expect(started?.ok).toBe(false);
    expect(started?.message).toContain("no agent was started");
    expect(started?.message).toContain("pipeline_strat");
    // At the resume after a decision.
    const runId = started?.runId ?? "";
    const run = (await h.open(runId)) as LocalRun;
    await run.completeStep("write", 1);
    await run.waitForRest(5_000);
    await run.decideHuman("approve", "approved");
    const seq = decisionOf(await run.journal()).decision?.seq ?? 0;
    failing.failResume = refusal;
    const resumed = await opts.resumeWorker?.(runId, seq, UUID);
    expect(resumed?.ok).toBe(false);
    expect(resumed?.message).toContain("was not resumed");
    expect(resumed?.message).toContain("pipeline_strat");
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

  real(
    "5m9d_worker_without_its_server_ends_as_a_dead_worker",
    async () => {
      // The accepted residual: the config is broken in the moment between the launcher's own check and
      // `claude` starting its server. The stand-in for `claude` breaks the config itself, starts the
      // kodel server its `--mcp-config` names as `claude` would, and, with no kodel tool, stops.
      const base = mkdtempSync(join(tmpdir(), "kodel-worker-dead-"));
      made.push(base);
      const bin = join(base, "bin");
      mkdirSync(bin, { recursive: true });
      const seen = join(base, "seen.jsonl");
      const script = join(base, "claude.mjs");
      const config = join(dir, ".kodel", "config.yaml");
      const bad = `${CONFIG}mcp:\n  roles:\n    worker:\n      add: [pipeline_strat]\n`;
      writeFileSync(
        script,
        [
          "import { spawnSync } from 'node:child_process';",
          "import { appendFileSync, writeFileSync } from 'node:fs';",
          "const argv = process.argv.slice(2);",
          "const valueOf = (flag) => { const at = argv.indexOf(flag); return at < 0 ? undefined : argv[at + 1]; };",
          "const id = valueOf('--session-id') ?? valueOf('--resume') ?? 'none';",
          `writeFileSync(${JSON.stringify(config)}, ${JSON.stringify(bad)});`,
          "const server = JSON.parse(valueOf('--mcp-config')).mcpServers.kodel;",
          "const { KODEL_ENGINE: _mark, ...env } = process.env;",
          "const ended = spawnSync(server.command, server.args, { input: '', encoding: 'utf8', env: { ...env, ...server.env } });",
          `appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ prompt: argv[1], code: ended.status, stderr: ended.stderr, stdout: ended.stdout }) + '\\n');`,
          "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: id, tools: ['Bash'] }) + '\\n');",
          "process.stdout.write(JSON.stringify({ type: 'result', session_id: id, num_turns: 1, is_error: true }) + '\\n');",
          "process.exit(1);",
          "",
        ].join("\n"),
      );
      const claude = join(bin, "claude");
      writeFileSync(
        claude,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
      );
      chmodSync(claude, 0o755);
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
        servedTools: () => workerServedTools(storeRoot()),
        which: async () => claude,
        exec: (await import("../src/worker-launcher-session")).execChild,
        platform: process.platform,
        clock: Date.now,
        uuid: () => UUID,
      });
      const h = host();
      const started = await h.start({ pipeline: "one", task: "left alone", restart: false });
      const runId = started.run.runId;
      const before = readFileSync(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8");
      const lines = () =>
        readFileSync(seen, "utf8")
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as { prompt: string; code: number; stderr: string; stdout: string },
          );

      // The start: the launcher's check passes (the config is good then), the worker's server does not start.
      await launcher.start({ runId, workdir: dir, title: "left alone" });
      const first = (await adapter.list({ name: `kw-${runId}` }))[0];
      if (!first) throw new Error("no record");
      await adapter.wait(first.id, { timeoutMs: 30_000 });
      expect(lines()[0]).toMatchObject({ code: 1, stdout: "" });
      expect(lines()[0]?.stderr).toContain('"pipeline_strat"');
      expect(lines()[0]?.prompt).toContain("If you have no pipeline_next_step tool");
      // A dead worker, as the daemon and the TUI report one: it exited with a failure outside a wait.
      const status = (await launcher.statuses([runId])).get(runId);
      expect(status).toMatchObject({ state: "exited", exitCode: 1 });
      const journal = journalOf(runId) as unknown as JournalRecord[];
      expect(
        resumeVerdict(
          { runId, status: "running", waitsForPerson: false, marks: serveDecisionOf(journal) },
          serveWorkerOf(status as WorkerStatus),
          { refuseMoved: true },
        ),
      ).toEqual({ kind: "no", why: "not_at_wait" });
      // The same at a resume: the session it resumes finds no kodel tool and stops.
      writeFileSync(config, CONFIG);
      await launcher.resume({ runId, workdir: dir, sessionId: UUID, decision: DECISION });
      const second = (await adapter.list({ name: `kw-${runId}-d17` }))[0];
      if (!second) throw new Error("no resume record");
      await adapter.wait(second.id, { timeoutMs: 30_000 });
      expect(lines()).toHaveLength(2);
      expect(lines()[1]).toMatchObject({ code: 1, stdout: "" });
      expect(lines()[1]?.prompt).toContain("may have changed since this session began");
      // No tool was called: the run is as it was, byte for byte.
      expect(readFileSync(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8")).toBe(
        before,
      );
      expect((await (await host().open(runId))?.state())?.status).toBe("running");
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
    const { serveLauncherOf } = await import("../src/worker-factory");
    const view = (await serveLauncherOf(launcher).statuses([RUN])).get(RUN);
    expect(view).toMatchObject({ state: "killed", stopped: true, lastOutputAt: 8_000 });
    adapter.finish(first.id, { state: "killed", reason: "timeout" });
    const timedOut = (await serveLauncherOf(launcher).statuses([RUN])).get(RUN);
    expect(timedOut?.stopped).toBeUndefined();
    expect(timedOut?.lastOutputAt).toBeUndefined();
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
