/**
 * `kodel agent start` (T-47, TASK-DSKQ): a person's own agent in a terminal session, the agent of a new
 * run through the one launcher (`--pipeline`), and the resume of a finished agent under its name
 * (`--resume`). The commands run through `runCli` with the session adapter, the attach client, the
 * probes and the launcher given by the test; the run of `--pipeline` is made by the real host.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EnginesAgainstHead,
  LocalPipelineHost,
  sessionEnv,
  type UnattendedEngines,
} from "@kodel-ai/local";
import {
  type AttachStream,
  ROLE_TOOLS,
  SessionError,
  type SessionListEntry,
} from "@kodel-ai/pipeline-core";
import { ptyChildEnv } from "../../local/src/session-pty";
import { ScriptedSessionAdapter } from "../../testkit/src/engine-fakes";
import { resumeHints, resumeProblem } from "../src/agent-commands";
import type { AttachClientOptions, AttachResult, AttachTerminal } from "../src/attach-client";
import type { Exec } from "../src/claude-worker";
import { runCli } from "../src/cli";
import type { PreflightInput, StartInput, WorkerLauncher } from "../src/worker-launcher";
import { createSessionWorkerLauncher } from "../src/worker-launcher-session";
import { FakeLauncher } from "./fake-launcher";
import { FakeSessions } from "./fake-sessions";

const MAIN = join(import.meta.dir, "../src/main.ts");
const UUID = "7f3b2a9c-1d4e-4f6a-9b8c-0d1e2f3a4b5c";
const OLD_UUID = "11111111-2222-4333-8444-555555555555";
const OLD = "a_0mw000000_old0";

const ONE = [
  "name: one",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write it",
  "  - slug: approve",
  "    kind: human",
  "    prompt: ok?",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

const BASE_CONFIG =
  "worktree:\n  mode: off\ntasks:\n  enabled: true\n  adapters:\n    local:\n      prefix: KDL\n";

let dir: string;
const made: string[] = [];

/** A project with one committed pipeline; `config` is appended to the base config. */
function project(config = ""): void {
  dir = mkdtempSync(join(tmpdir(), "kodel-agent-start-"));
  made.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  mkdirSync(join(dir, ".kodel", "pipelines"), { recursive: true });
  writeFileSync(join(dir, ".kodel", "pipelines", "one.yaml"), ONE);
  writeFileSync(join(dir, ".kodel", "config.yaml"), `${BASE_CONFIG}${config}`);
  writeFileSync(join(dir, ".gitignore"), ".kodel/runs\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
}
beforeEach(() => project());
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const terminal = (): AttachTerminal => ({
  size: () => ({ cols: 100, rows: 30 }),
  raw() {},
  write: () => true,
  onDrain() {},
  onInput() {},
  onResize() {},
  onSignal() {},
  release() {},
});

interface World {
  sessions?: FakeSessions | ScriptedSessionAdapter;
  launcher?: WorkerLauncher | ((engines?: () => Promise<UnattendedEngines>) => WorkerLauncher);
  engines?: EnginesAgainstHead;
  environment?: Record<string, string | undefined>;
  interactive?: boolean;
  confirm?: boolean;
  pty?: { ok: true } | { ok: false; reason: string };
  /** What `which` answers for the agent's program; found unless a test says not. */
  found?: boolean;
  /** How the attach ends. */
  attachEnd?: AttachResult;
}

async function start(world: World, ...args: string[]) {
  let out = "";
  let err = "";
  const asked: string[] = [];
  const attaches: { name: string; at: number }[] = [];
  const sessions = world.sessions ?? new FakeSessions();
  const launcher = world.launcher ?? new FakeLauncher();
  const code = await runCli(["--root", dir, "agent", "start", ...args], {
    cwd: dir,
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    interactive: world.interactive ?? true,
    environment: world.environment ?? { PATH: "/usr/bin", HOME: "/home/u" },
    confirm: async (question) => {
      asked.push(question);
      return world.confirm ?? true;
    },
    select: async () => [],
    ptyProbe: () => world.pty ?? { ok: true },
    terminalSize: () => ({ cols: 100, rows: 30 }),
    agent: {
      sessions: async () => sessions,
      attachTerminal: terminal,
      attach: async (options: AttachClientOptions) => {
        // where in the output the attach began: after the `started` line
        attaches.push({ name: options.name, at: out.length });
        return world.attachEnd ?? { end: { how: "detached" }, line: `[detached: ${options.name}]` };
      },
      which: async (name) => (world.found === false ? undefined : `/usr/bin/${name}`),
      uuid: () => UUID,
      readText: async () => undefined,
      engines: async () => world.engines ?? { state: "committed", engines: {} },
      launcher: async (engines) => (typeof launcher === "function" ? launcher(engines) : launcher),
    },
  });
  return { code, out, err, asked, attaches, sessions };
}

const host = () => new LocalPipelineHost({ root: dir, heartbeatMs: 0, environment: {} });

const stopped = (over: Partial<SessionListEntry> = {}): SessionListEntry => ({
  id: OLD,
  name: "cc",
  mode: "pty",
  command: "claude --session-id x",
  agent: { engine: "claude", session: OLD_UUID, source: "chosen" },
  status: { state: "killed", reason: "stopped", since: 1_000 },
  ...over,
});

describe("t47 kodel agent start, a person's own agent", () => {
  test("t47_agent_start_plain_prints_argv_and_attaches", async () => {
    const sessions = new FakeSessions();
    const r = await start({ sessions }, "--name", "CC", "fix", "the", "login");
    expect(r.code, r.err).toBe(0);
    // The claude profile's command, the chosen id, the prompt after `--` with its newline.
    const [spec] = sessions.specs;
    expect(spec?.argv).toEqual(["claude", "--session-id", UUID, "--", "fix the login\n"]);
    expect(spec).toMatchObject({
      cwd: dir,
      origin: "cli",
      mode: "pty",
      name: "CC",
      size: { cols: 100, rows: 30 },
      agent: { engine: "claude", session: UUID },
    });
    expect(sessions.options).toEqual([{}]);
    // No kodel server of ours, no permission flag, no list: it is the person's own session.
    const flags = (spec?.argv ?? []).join(" ");
    for (const absent of [
      "--mcp-config",
      "--strict-mcp-config",
      "--permission-mode",
      "--allowedTools",
      "--disallowedTools",
      "-p",
    ]) {
      expect((spec?.argv ?? []).includes(absent), absent).toBe(false);
    }
    expect(flags).not.toContain("kodel");
    // The session's environment is the person's own, as a worker gets it (the adapter adds its mark).
    expect(spec?.env).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
    expect(spec?.inheritEnv).toBe(false);
    expect(sessionEnv(spec?.env, spec?.inheritEnv ?? true, { PATH: "/usr/bin" })).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      KODEL_ENGINE: "1",
    });
    // It prints the argv and what an unattended start may meet, then `started`, then attaches.
    expect(r.out).toContain(`starts: claude --session-id ${UUID} -- 'fix the login`);
    expect(r.out).toContain("waits at its own questions");
    const startedAt = r.out.indexOf("started a_");
    expect(startedAt).toBeGreaterThan(r.out.indexOf("starts: "));
    expect(r.out).toMatch(/started a_\S+ \(cc\)\n/);
    expect(r.attaches.length).toBe(1);
    expect(r.attaches[0]?.name).toBe("cc");
    expect(r.attaches[0]?.at).toBeGreaterThan(startedAt);
    expect(sessions.attached).toEqual([sessions.rows[0]?.id ?? ""]);
    expect(r.asked).toEqual([]);

    // `--bg`: nothing is attached, and the line says how to.
    const bg = new FakeSessions();
    const detached = await start({ sessions: bg }, "--bg", "--name", "bb", "hello");
    expect(detached.code).toBe(0);
    expect(detached.attaches).toEqual([]);
    expect(bg.attached).toEqual([]);
    expect(detached.out).toContain("attach with: kodel agent attach bb\n");

    // No prompt: the agent starts with none.
    const bare = new FakeSessions();
    expect((await start({ sessions: bare }, "--bg")).code).toBe(0);
    expect(bare.specs[0]?.argv).toEqual(["claude", "--session-id", UUID]);

    // The session's environment is the person's shell, without what marks a Claude Code session or kodel's own.
    const marked = new FakeSessions();
    await start(
      {
        sessions: marked,
        environment: {
          PATH: "/usr/bin",
          HOME: "/home/u",
          CLAUDECODE: "1",
          CLAUDE_CODE_ENTRYPOINT: "cli",
          KODEL_STATE_DIR: "/somewhere",
        },
      },
      "--bg",
    );
    expect(marked.specs[0]?.inheritEnv).toBe(false);
    expect(marked.specs[0]?.env).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });

    // A one-word prompt that names a subcommand of the agent stays a prompt.
    const word = new FakeSessions();
    await start({ sessions: word }, "--bg", "doctor");
    expect(word.specs[0]?.argv?.slice(-2)).toEqual(["--", "doctor\n"]);

    // The attach's problem is the command's.
    const lost = await start(
      {
        attachEnd: {
          end: { how: "lost" },
          line: "[detached: x]",
          problem: "the connection to the session was lost",
        },
      },
      "hello",
    );
    expect(lost.code).toBe(1);
    expect(lost.err).toContain("the connection to the session was lost");

    // Refused before anything is started: no program, no terminal.
    const none = new FakeSessions();
    const missing = await start({ sessions: none, found: false }, "hello");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("claude was not found on PATH");
    const noPty = await start(
      { sessions: none, pty: { ok: false, reason: "a terminal session cannot run under Bun" } },
      "hello",
    );
    expect(noPty.code).toBe(1);
    expect(noPty.err).toContain("a terminal session cannot run under Bun");
    expect(none.specs).toEqual([]);
  });

  test("t47_agent_start_plain_shows_an_engines_block_that_is_not_committed_and_asks", async () => {
    const engines: EnginesAgainstHead = {
      state: "differs",
      head: {},
      engines: { claude: { terminal: { command: ["/opt/claude", "--model", "opus"] } } },
    };
    const sessions = new FakeSessions();
    const yes = await start({ sessions, engines }, "--bg", "hello");
    expect(yes.code, yes.err).toBe(0);
    expect(yes.asked).toEqual(["Start the agent with this engines block?"]);
    expect(yes.out).toContain("is not the committed one");
    expect(yes.out).toContain("engines.claude.terminal");
    // The question comes before the start, and the program is the person's.
    expect(yes.out.indexOf("is not the committed one")).toBeLessThan(yes.out.indexOf("started "));
    expect(sessions.specs[0]?.argv).toEqual([
      "/opt/claude",
      "--model",
      "opus",
      "--session-id",
      UUID,
      "--",
      "hello\n",
    ]);
    const refusedBy = new FakeSessions();
    const no = await start({ sessions: refusedBy, engines, confirm: false }, "--bg", "hello");
    expect(no.code).toBe(1);
    expect(no.err).toContain("not confirmed");
    expect(refusedBy.specs).toEqual([]);
    // git itself failed: the reason is shown and the person is asked.
    const failed = await start(
      { engines: { state: "failed", reason: "fatal: detected dubious ownership", engines: {} } },
      "--bg",
      "hello",
    );
    expect(failed.out).toContain("fatal: detected dubious ownership");
    expect(failed.asked.length).toBe(1);
    // The committed block asks nothing.
    const committed = await start(
      { engines: { state: "committed", engines: { claude: { worker: "print" } } } },
      "--bg",
      "hello",
    );
    expect(committed.asked).toEqual([]);
    // `worker: print` is about workers: a person's own agent is always in a terminal.
    expect((committed.sessions as FakeSessions).specs[0]?.mode).toBe("pty");
  });

  test("t47_agent_start_plain_warns_about_the_state_dir", async () => {
    const withDir = await start(
      { environment: { PATH: "/usr/bin", HOME: "/home/u", KODEL_STATE_DIR: "/tmp/state-x" } },
      "--bg",
      "hello",
    );
    expect(withDir.code, withDir.err).toBe(0);
    expect(withDir.out).toContain("warning: KODEL_STATE_DIR is set in your shell (/tmp/state-x)");
    expect(withDir.out).toContain("keeps its state in the default place");
    const without = await start({}, "--bg", "hello");
    expect(without.out).not.toContain("KODEL_STATE_DIR");
  });

  test("t47_agent_start_plain_says_its_server_is_a_worker", async () => {
    project("decisions:\n  agent:\n    gate: true\n");
    const on = await start({}, "--bg", "hello");
    expect(on.code, on.err).toBe(0);
    // 5M9D: inside a session the project's server is a worker, so the block gives this agent nothing.
    expect(on.out).toContain("is a worker inside a kodel session");
    expect(on.out).toContain("decides nothing, whatever decisions.agent (gate) says");
    expect(on.out).toContain("--role manager or --read-only does not start there");
    expect(on.out).not.toContain("may decide");
    expect(on.out.indexOf("is a worker inside")).toBeLessThan(on.out.indexOf("started a_"));
    project();
    const off = await start({}, "--bg", "hello");
    expect(off.out).toContain("is a worker inside a kodel session");
    expect(off.out).toContain("decides nothing; one set to");
    expect(off.out).not.toContain("decisions.agent");
  });

  test("t47_agent_start_plain_session_makes_the_projects_server_a_worker", async () => {
    project("decisions:\n  agent:\n    gate: true\n");
    const sessions = new FakeSessions();
    const r = await start({ sessions }, "--bg", "hello");
    expect(r.code, r.err).toBe(0);
    const [spec] = sessions.specs;
    // The environment the child of this session gets: what the adapter and the PTY holder make of the spec.
    expect(spec).toBeDefined();
    const child = ptyChildEnv(sessionEnv(spec?.env, spec?.inheritEnv ?? true, {}));
    expect(child.KODEL_ENGINE).toBe("1");
    const home = mkdtempSync(join(tmpdir(), "kodel-agent-start-home-"));
    made.push(home);
    // The project's own server as `.mcp.json` starts it (`kodel mcp`, no role), in that environment.
    const serve = (...args: string[]) =>
      spawnSync(process.execPath, [MAIN, "--root", dir, "mcp", ...args], {
        cwd: dir,
        env: { ...child, PATH: process.env.PATH ?? "", HOME: home },
        input: "",
        encoding: "utf8",
        timeout: 30_000,
      });
    const plainServer = serve();
    expect(plainServer.stderr).toContain(`serving ${ROLE_TOOLS.worker.length} tools (role worker)`);
    expect(plainServer.stderr).not.toContain("every tool");
    for (const name of ["pipeline_decide_gate", "pipeline_accept_change", "history_runs"]) {
      expect(ROLE_TOOLS.worker.includes(name), name).toBe(false);
    }
    // A project whose server is a manager gets none in this session, with the reason.
    const manager = serve("--role", "manager");
    expect(manager.status).toBe(1);
    expect(manager.stderr).toContain("KODEL_ENGINE is set");
    expect(manager.stdout).toBe("");
  }, 120_000);
});

/** The scripted adapter with a terminal to attach to. */
class AttachableScripted extends ScriptedSessionAdapter {
  readonly attached: string[] = [];
  async attachable(id: string) {
    const live = this.sessions.get(id)?.status.state === "running";
    return live ? { ok: true as const } : { ok: false as const, reason: "it does not run" };
  }
  async attach(id: string): Promise<AttachStream> {
    this.attached.push(id);
    return {
      write() {},
      pending: () => 0,
      onData() {},
      onClose() {},
      pause() {},
      resume() {},
      close() {},
    };
  }
}

/** The real session launcher over a scripted adapter: `agent ls --json` is answered from its sessions. */
function sessionLauncher(
  adapter: ScriptedSessionAdapter,
  worker: "terminal" | "print",
  seen: { engines: (UnattendedEngines | undefined)[] } = { engines: [] },
) {
  const exec: Exec = async (file, args) => {
    if (file === "claude") return { stdout: `{"loggedIn":true}\n`, stderr: "", code: 0 };
    if (args.includes("ls")) {
      const rows: SessionListEntry[] = [...adapter.sessions.values()].map((s) => ({
        id: s.id,
        ...(s.name === undefined ? {} : { name: s.name }),
        command: (s.spec.argv ?? []).join(" "),
        status: { ...s.status },
        mode: s.spec.mode ?? "pipes",
        ...(s.spec.agent === undefined ? {} : { agent: { ...s.spec.agent, source: "chosen" } }),
      }));
      return { stdout: JSON.stringify(rows), stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "unknown", code: 2 };
  };
  return (given?: () => Promise<UnattendedEngines>) =>
    createSessionWorkerLauncher({
      adapter,
      self: { exec: "/usr/local/bin/node", args: ["/opt/kodel/dist/kodel.js"] },
      root: dir,
      stateBase: "/home/u/.kodel",
      environment: { PATH: "/usr/bin", HOME: "/home/u" },
      rules: [],
      servedTools: ["pipeline_next_step"],
      which: async () => "/usr/bin/claude",
      exec,
      platform: "darwin",
      clock: () => 1_000,
      uuid: () => UUID,
      ptyProbe: () => ({ ok: true }),
      readText: async () => JSON.stringify({ projects: { "/": { hasTrustDialogAccepted: true } } }),
      engines: async () => {
        // The block the command accepted is the one this launcher starts with.
        const accepted = await given?.();
        seen.engines.push(accepted);
        return { ok: true, engines: { claude: { worker } } };
      },
    });
}

describe("t47 kodel agent start --pipeline", () => {
  test("t47_agent_start_with_pipeline_uses_the_launcher", async () => {
    // A launcher that looks, at the start, whether the start lock is held.
    let lockHeld: boolean | undefined;
    const preflights: PreflightInput[] = [];
    class Watching extends FakeLauncher {
      override async preflight(input: PreflightInput) {
        preflights.push(input);
        return super.preflight(input);
      }
      override async start(input: StartInput) {
        lockHeld = (readdirSync(join(dir, ".kodel"), { recursive: true }) as string[]).some(
          (file) => file.endsWith("worker-start.lock"),
        );
        return super.start(input);
      }
    }
    const launcher = new Watching();
    const sessions = new FakeSessions();
    const r = await start({ sessions, launcher }, "--pipeline", "one", "Add a flag", "to status");
    expect(r.code, r.err).toBe(0);
    // One run with no task, made by kodel itself; one worker, through the launcher, under the lock.
    const runs = await host().runSummaries();
    expect(runs.length).toBe(1);
    const run = runs[0];
    expect(run?.state?.taskKey).toBeUndefined();
    expect(run?.state?.status).toBe("running");
    expect(launcher.starts).toEqual([
      { runId: run?.meta.runId ?? "", workdir: dir, title: "Add a flag to status" },
    ]);
    expect(lockHeld).toBe(true);
    expect(
      (readdirSync(join(dir, ".kodel"), { recursive: true }) as string[]).some((file) =>
        file.endsWith("worker-start.lock"),
      ),
    ).toBe(false);
    // The preflight is the launcher's, for a run with no task; a person is there.
    expect(preflights).toEqual([
      {
        dialog: false,
        taskLink: false,
        noTask: true,
        pipelines: 1,
        worktreesDir: join(dir, ".kodel/worktrees"),
      },
    ]);
    // The command itself starts no session: the worker is the launcher's.
    expect(sessions.specs).toEqual([]);
    // No tracker write.
    expect(existsSync(join(dir, ".kodel", "tasks"))).toBe(false);
    expect(r.out).toContain(`run ${run?.meta.runId} (agent kw-${run?.meta.runId})`);

    // `--name` is refused: the agent of a run is named after the run.
    const named = await start({ launcher }, "--pipeline", "one", "--name", "mine", "Add a flag");
    expect(named.code).toBe(1);
    expect(named.err).toContain("--pipeline takes no --name");
    // A pipeline that is not there, and a preflight that refuses: no run is made.
    const unknown = await start({ launcher }, "--pipeline", "nope", "Add a flag");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('there is no pipeline "nope"');
    launcher.preflightResult = { ok: false, reason: "claude is not signed in" };
    const refused = await start({ launcher }, "--pipeline", "one", "Another");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("cannot start: claude is not signed in");
    expect((await host().runSummaries()).length).toBe(1);
    expect(launcher.starts.length).toBe(1);

    // Human-only: under the engine's mark, and without a terminal, nothing happens.
    const marked = await start(
      { launcher, environment: { PATH: "/usr/bin", KODEL_ENGINE: "1" } },
      "--pipeline",
      "one",
      "x",
    );
    expect(marked.code).toBe(1);
    expect(marked.err).toContain("for a person");
    const script = await start({ launcher, interactive: false }, "--pipeline", "one", "x");
    expect(script.code).toBe(1);
    expect(script.err).toContain("for a person at a terminal");
    expect(launcher.starts.length).toBe(1);
  });

  test("t47_agent_start_flag_table", async () => {
    // `--pipeline` with `worker: terminal` attaches to the worker; with `--bg` it does not.
    const term = new AttachableScripted();
    const seen = { engines: [] as (UnattendedEngines | undefined)[] };
    const attached = await start(
      { sessions: term, launcher: sessionLauncher(term, "terminal", seen) },
      "--pipeline",
      "one",
      "Add a flag",
    );
    expect(attached.code, attached.err).toBe(0);
    expect(term.specs.length).toBe(1);
    expect(term.specs[0]).toMatchObject({ mode: "pty", agent: { engine: "claude" } });
    expect(term.specs[0]?.name).toMatch(/^kw-r_/);
    expect(term.attached).toEqual([term.only().id]);
    expect(attached.attaches.map((a) => a.name)).toEqual([term.specs[0]?.name ?? ""]);
    // The launcher was given the block the command read (here: the committed one).
    expect(seen.engines.every((e) => e?.ok === true)).toBe(true);

    // A worker whose holder still opens its terminal is asked again, not given up on at the first answer.
    const slow = new AttachableScripted();
    const real = sessionLauncher(slow, "terminal");
    let asks = 0;
    const late = await start(
      {
        sessions: slow,
        launcher: (engines) => {
          const base = real(engines);
          return {
            ...base,
            statuses: async (ids) => {
              const map = await base.statuses(ids);
              if (asks < 3) for (const [id, w] of map) map.set(id, { ...w, state: "starting" });
              return map;
            },
            attachable: async (runId) =>
              ++asks < 3
                ? { ok: false, reason: "its terminal is not open yet" }
                : base.attachable(runId),
          };
        },
      },
      "--pipeline",
      "one",
      "Add slowly",
    );
    expect(late.code, late.err).toBe(0);
    expect(asks).toBe(3);
    expect(late.out).not.toContain("not attached");
    expect(slow.attached).toEqual([slow.only().id]);

    const bg = new AttachableScripted();
    const detached = await start(
      { sessions: bg, launcher: sessionLauncher(bg, "terminal") },
      "--pipeline",
      "one",
      "--bg",
      "Add another",
    );
    expect(detached.code, detached.err).toBe(0);
    expect(bg.specs.length).toBe(1);
    expect(bg.attached).toEqual([]);
    expect(detached.out).toContain(`attach with: kodel agent attach ${bg.specs[0]?.name}`);

    // `--pipeline` with `worker: print`: today's `-p` worker, nothing attached, one line says so.
    const print = new AttachableScripted();
    const printed = await start(
      { sessions: print, launcher: sessionLauncher(print, "print") },
      "--pipeline",
      "one",
      "Add a third",
    );
    expect(printed.code, printed.err).toBe(0);
    expect(print.specs[0]?.argv?.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(print.specs[0]?.mode).toBeUndefined();
    expect(print.attached).toEqual([]);
    expect(printed.attaches).toEqual([]);
    expect(printed.out).toContain("not attached: ");
    expect(printed.out).toContain("runs without a terminal (worker: print)");

    // Refused by name, nothing started, no run made.
    const runsBefore = (await host().runSummaries()).length;
    const none = new FakeSessions();
    const launcher = new FakeLauncher();
    const rows: [string[], string][] = [
      [["--pipeline", "one"], "--pipeline needs a prompt"],
      [["--pipeline", "one", "--name", "x", "do it"], "--pipeline takes no --name"],
      [["--resume", "cc", "and", "a", "prompt"], "--resume takes no prompt"],
      [["--resume", "cc", "--pipeline", "one"], "--resume takes no --pipeline"],
      [["--resume", "cc", "--name", "other"], "--resume takes no --name"],
      [["--name", "not a name", "hello"], "the name is not valid"],
    ];
    for (const [args, reason] of rows) {
      const r = await start({ sessions: none, launcher }, ...args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err, args.join(" ")).toContain(reason);
    }
    // Which engine a worker uses is not built: `--engine` is an unknown flag.
    const engine = await start({ sessions: none, launcher }, "--engine", "codex", "hello");
    expect(engine.code).toBe(1);
    expect(engine.err).toContain("unknown option '--engine'");
    expect(none.specs).toEqual([]);
    expect(none.calls).toEqual([]);
    expect(launcher.starts).toEqual([]);
    expect(launcher.preflights).toEqual([]);
    expect((await host().runSummaries()).length).toBe(runsBefore);

    // `decisions.dialog` on: a plain start is not refused and says where its dialogs show; `--pipeline` is.
    project("decisions:\n  dialog: true\n");
    const plainOne = new FakeSessions();
    const plain = await start({ sessions: plainOne }, "--bg", "hello");
    expect(plain.code, plain.err).toBe(0);
    expect(plainOne.specs.length).toBe(1);
    expect(plain.out).toContain(
      "decisions.dialog is on: this agent's dialogs show in its own terminal",
    );
    for (const worker of ["terminal", "print"] as const) {
      const adapter = new AttachableScripted();
      const refused = await start(
        { sessions: adapter, launcher: sessionLauncher(adapter, worker) },
        "--pipeline",
        "one",
        "Add a flag",
      );
      expect(refused.code, worker).toBe(1);
      expect(refused.err, worker).toContain("decisions.dialog");
      expect(adapter.starts, worker).toBe(0);
    }
    expect(await host().runSummaries()).toEqual([]);
  });
});

describe("t47 kodel agent start --resume", () => {
  test("t47_resume_keeps_the_name_and_links_the_old_record", async () => {
    const sessions = new FakeSessions();
    sessions.add(stopped());
    const r = await start({ sessions }, "--resume", "CC", "--bg");
    expect(r.code, r.err).toBe(0);
    // A new terminal session with claude's resume argv, the same name, the same conversation.
    const [spec] = sessions.specs;
    expect(spec?.argv).toEqual(["claude", "--resume", OLD_UUID]);
    expect(spec).toMatchObject({
      cwd: dir,
      origin: "cli",
      mode: "pty",
      name: "cc",
      agent: { engine: "claude", session: OLD_UUID, resumes: OLD },
    });
    // The adapter is told whose name to take: it moves the marker, with the rollback.
    expect(sessions.options).toEqual([{ takeName: OLD }]);
    // The old record stays listed beside the new one.
    const rows = await sessions.list();
    expect(rows.map((row) => row.id)).toContain(OLD);
    expect(rows.length).toBe(2);
    const fresh = rows.find((row) => row.id !== OLD);
    expect(fresh).toMatchObject({ name: "cc", agent: { resumes: OLD, session: OLD_UUID } });
    expect(r.out).toContain(`starts: claude --resume ${OLD_UUID}\n`);
    expect(r.out).toContain(`resumed ${OLD} as ${fresh?.id} (cc)\n`);
    expect(r.out).toContain("attach with: kodel agent attach cc\n");

    // By id, attached: the newest record of the name is the one that runs now, so the old id is
    // named outright; the adapter then answers for the name (it moved on).
    sessions.failStart = new SessionError("NAME_TAKEN", "a session named cc exists");
    const again = await start({ sessions }, "--resume", OLD);
    expect(again.code).toBe(1);
    expect(again.err).toContain("NAME_TAKEN: a session named cc exists");
    expect(again.attaches).toEqual([]);

    // Without `--bg` the terminal is connected to the resumed agent.
    const other = new FakeSessions();
    other.add(stopped({ status: { state: "exited", exitCode: 0 } }));
    const attached = await start({ sessions: other }, "--resume", "cc");
    expect(attached.code, attached.err).toBe(0);
    expect(attached.attaches.map((a) => a.name)).toEqual(["cc"]);
    expect(other.attached.length).toBe(1);

    // A session with no name is continued by its id and stays without one.
    const unnamed = new FakeSessions();
    const { name: _name, ...bare } = stopped();
    unnamed.add(bare);
    const byId = await start({ sessions: unnamed }, "--resume", OLD, "--bg");
    expect(byId.code, byId.err).toBe(0);
    expect(unnamed.specs[0]?.name).toBeUndefined();
    expect(unnamed.options).toEqual([{ takeName: OLD }]);

    // Of several records of a name the newest is the one continued.
    const many = new FakeSessions();
    many.add(stopped({ id: "a_0mw000000_aaaa" }));
    many.add(
      stopped({
        id: "a_0mw000001_bbbb",
        agent: {
          engine: "claude",
          session: OLD_UUID,
          source: "chosen",
          resumes: "a_0mw000000_aaaa",
        },
      }),
    );
    await start({ sessions: many }, "--resume", "cc", "--bg");
    expect(many.options).toEqual([{ takeName: "a_0mw000001_bbbb" }]);

    // `agent ls` names the command for a finished agent that can be continued, the newest of a name only.
    expect(resumeHints([stopped()])).toEqual([
      "cc can be continued: kodel agent start --resume cc",
    ]);
    expect(resumeHints(await many.list())).toEqual([]); // the newest of the name runs now
    expect(resumeHints([stopped({ status: { state: "running" } })])).toEqual([]);
  });

  test("t47_resume_refusals", async () => {
    const rows: [string, SessionListEntry, string][] = [
      ["a running session", stopped({ status: { state: "running" } }), "still runs"],
      ["a starting session", stopped({ status: { state: "starting" } }), "still runs"],
      [
        "lost, its process still runs",
        stopped({ status: { state: "lost", reason: "holder_gone", childAlive: true } }),
        `its process still runs without a holder; stop it: kodel agent stop ${OLD}`,
      ],
      [
        "killed, its process still runs",
        stopped({ status: { state: "killed", reason: "holder_error", childAlive: true } }),
        `its process still runs without a holder; stop it: kodel agent stop ${OLD}`,
      ],
      [
        "no agent record",
        (({ agent: _agent, ...row }) => row)(stopped()),
        "the id of the conversation of agent cc is not known",
      ],
      [
        "an agent record without an id",
        stopped({ agent: { engine: "claude" } }),
        "the id of the conversation of agent cc is not known",
      ],
      [
        "an agent record that does not name claude",
        stopped({ agent: { engine: "codex", session: OLD_UUID, source: "observed" } }),
        "agent cc is codex: only claude can be resumed in this version",
      ],
      [
        "the worker of a run",
        stopped({ name: "kw-r_0mw53d7fj_o2lc" }),
        "is the agent of a run that you stopped: after your decision only s in kodel tui resumes it; kodel serve leaves it to you",
      ],
      [
        "the resumed worker of a run",
        stopped({ name: "kw-r_0mw53d7fj_o2lc-d17" }),
        "is the agent of a run",
      ],
      [
        "the session of an engine step",
        stopped({ name: "ke-r_0mw53d7fj_o2lc-3-1" }),
        "is the session of an engine step",
      ],
      ["a pipes session", stopped({ mode: "pipes" }), "ran without a terminal"],
      [
        "a record that cannot be read",
        stopped({ problem: "CANNOT_READ", status: { state: "lost" } }),
        "cannot be read",
      ],
    ];
    for (const [what, row, reason] of rows) {
      expect(resumeProblem(row), what).toContain(reason);
      const sessions = new FakeSessions();
      sessions.add(row);
      const r = await start({ sessions }, "--resume", row.name ?? row.id);
      expect(r.code, what).toBe(1);
      expect(r.err, what).toContain(reason);
      // Nothing was started, asked or printed as a start.
      expect(sessions.specs, what).toEqual([]);
      expect(r.asked, what).toEqual([]);
      expect(r.out, what).not.toContain("starts:");
      // and `agent ls` offers no resume for it
      expect(resumeHints([row]), what).toEqual([]);
    }
    expect(resumeProblem(stopped())).toBeUndefined();

    // The agent of a run: who resumes it depends on how it ended (a stop is the person's, the daemon leaves it).
    const kw = (over: Partial<SessionListEntry>) =>
      resumeProblem(stopped({ name: "kw-r_0mw53d7fj_o2lc", ...over }));
    const BOTH =
      "when it ended at a wait, kodel serve or s in kodel tui resumes it after your decision";
    const NOBODY = "did not end at a wait: nothing resumes it";
    const ends: [string, Partial<SessionListEntry>, string, string?][] = [
      ["stopped by the person", {}, "only s in kodel tui resumes it", "kodel serve or s"],
      ["quit", { status: { state: "exited", exitCode: 0 } }, BOTH],
      ["the holder told to end", { status: { state: "killed", signal: "SIGTERM" } }, BOTH],
      ["a timeout", { status: { state: "killed", reason: "timeout" } }, BOTH],
      ["the holder gone", { status: { state: "lost", reason: "holder_gone" } }, BOTH],
      ["a start that never came", { status: { state: "killed", reason: "start_late" } }, NOBODY],
      [
        "a print worker at a wait",
        { mode: "pipes", status: { state: "exited", exitCode: 0 } },
        BOTH,
      ],
      [
        "a print worker that died",
        { mode: "pipes", status: { state: "killed", signal: "SIGKILL" } },
        NOBODY,
      ],
      ["a print worker stopped", { mode: "pipes" }, NOBODY],
      ["one that runs", { status: { state: "running" } }, "still runs: kodel agent attach kw-"],
      [
        "a print one that runs",
        { mode: "pipes", status: { state: "running" } },
        "still runs: kodel agent logs kw-",
      ],
      [
        "its process still runs",
        { status: { state: "lost", reason: "holder_gone", childAlive: true } },
        `stop it: kodel agent stop ${OLD}`,
      ],
    ];
    for (const [what, over, said, notSaid] of ends) {
      expect(kw(over), what).toContain(said);
      expect(kw(over), what).toContain("is the agent of a run");
      if (notSaid !== undefined) expect(kw(over), what).not.toContain(notSaid);
      if (said !== BOTH) expect(kw(over), what).not.toContain("kodel serve or s");
    }
    const both = await start({}, "--resume", "cc", "--pipeline", "one");
    expect(both.err).toContain("(one you stopped: only by s)");

    // No such agent.
    const empty = await start({}, "--resume", "nobody");
    expect(empty.code).toBe(1);
    expect(empty.err).toContain('NOT_FOUND: no agent "nobody"');

    // A session the engine started (a host session): the adapter knows whose it is and refuses before
    // anything is written; the marker of such a session is never moved.
    const hostOne = new FakeSessions();
    hostOne.add(stopped());
    hostOne.failStart = new SessionError(
      "UNSUPPORTED",
      `session ${OLD} was started by the engine, not by a person: its name is never moved`,
    );
    const refused = await start({ sessions: hostOne }, "--resume", "cc");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("UNSUPPORTED: session");
    expect(refused.err).toContain("its name is never moved");
    expect(hostOne.rows.length).toBe(1);
    expect(refused.attaches).toEqual([]);
  });
});
