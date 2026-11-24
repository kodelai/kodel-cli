/**
 * Workers in a terminal of their own, on a real terminal (TASK-EKAV, T-47), in two parts.
 *
 * The TUI's `o`: the built `kodel tui` on Node in a terminal of the test's own, two runs of a project,
 * and for each run a session `kw-<run>` in a terminal of its own with a shell script standing for the
 * agent. The screen hands its terminal to `kodel agent attach --keep-screen` and takes it back where it
 * was; from the key to the redraw the alternate screen is never left, so the shell is not seen.
 *
 * The launcher: a worker started through the one launcher, with the scripted fake terminal agent of the
 * testkit as its program (the second half of this file).
 */
import { afterEach, describe, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSIDE_SESSION_REFUSAL } from "../../packages/cli/src/human-only";
import { serveWorkerOf } from "../../packages/cli/src/worker-factory";
import type { WorkerLauncher, WorkerStatus } from "../../packages/cli/src/worker-launcher";
import {
  createSessionWorkerLauncher,
  execChild,
  findOnPath,
} from "../../packages/cli/src/worker-launcher-session";
import {
  LocalPipelineHost,
  type LocalRun,
  PipesSessionAdapter,
  sessionDirOf,
} from "../../packages/local/src";
import { SessionError } from "../../packages/pipeline-core/src";
import { decisionOf, resumeVerdict } from "../../packages/pipeline-core/src/serve";
import {
  type FakeTerminalAgent,
  type FakeTerminalAgentOptions,
  writeFakeTerminalAgent,
} from "../../packages/testkit/src";
import {
  ARTIFACT,
  alive,
  Host,
  KODEL,
  realPtyTests,
  shortDir,
  sleep,
  type Term,
  until,
  type World,
  world,
} from "./harness";

const real = realPtyTests();
const ptyTest = real.test;

const ALT_ON = "\u001b[?1049h";
const ALT_OFF = "\u001b[?1049l";
const CURSOR_OFF = "\u001b[?25l";
const PASTE_ON = "\u001b[?2004h";
const CLEAR = "\u001b[2J\u001b[H";
/** Ctrl+\: the detach chord of `kodel agent attach`. */
const DETACH = "\u001c";

const PIPELINE = [
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

/** A terminal's output is kept as a binary string: the bytes of a text that is not ASCII, to look for in it. */
const raw = (text: string) => Buffer.from(text, "utf8").toString("latin1");

const worlds: World[] = [];
const hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) host.close();
  for (const w of worlds.splice(0)) await w.dispose();
});

/**
 * A project with two runs at their first step, each with its agent in a terminal session, and the TUI
 * open on it. `agent` is the shell script that stands for the agent; `$RUN` in it is the run's id.
 */
async function scene(agent: string, size = { cols: 140, rows: 40 }) {
  const w = world();
  worlds.push(w);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: w.root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  mkdirSync(join(w.root, ".kodel", "pipelines"), { recursive: true });
  writeFileSync(join(w.root, ".kodel", "pipelines", "one.yaml"), PIPELINE);
  writeFileSync(join(w.root, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
  writeFileSync(join(w.root, ".gitignore"), ".kodel/runs\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");

  const pipelines = new LocalPipelineHost({ root: w.root, heartbeatMs: 0, environment: w.env });
  const runs: string[] = [];
  const sessions = new Map<string, string>();
  for (const task of ["the first task", "the second task"]) {
    const started = await pipelines.start({ pipeline: "one", task, restart: true });
    const run = started.run.runId;
    runs.push(run);
    const session = await w.adapter().start({
      argv: ["sh", "-c", agent.replaceAll("$RUN", run)],
      cwd: w.root,
      origin: "cli",
      mode: "pty",
      name: `kw-${run}`,
      timeoutMs: 120_000,
      agent: { engine: "claude", session: "7f3b2a9c-1d4e-4f6a-9b8c-0d1e2f3a4b5c" },
    });
    sessions.set(run, session.id);
  }
  const host = new Host();
  hosts.push(host);
  const term = await host.open("node", [ARTIFACT, "tui"], { cwd: w.root, env: w.env, ...size });
  // The list, and the records of the agents read once: the rows say what the agents do.
  await term.sees("RUNNING", 30_000);
  await term.sees(raw("◆ running"), 30_000);
  return { w, term, runs, sessions };
}

/** The run whose card the screen shows, read from what was drawn since `from`. */
const shownRun = (term: Term, runs: readonly string[], from: number): string | undefined => {
  const drawn = term.output.slice(from);
  let found: { run: string; at: number } | undefined;
  for (const run of runs) {
    // The run's id is on its card only: the rows of the list show titles.
    const at = drawn.lastIndexOf(raw(`${run} · one`));
    if (at >= 0 && (found === undefined || at > found.at)) found = { run, at };
  }
  return found?.run;
};

/** Moves to the second run and opens its card; answers the run the card is about. */
async function onSecondCard(term: Term, runs: readonly string[]): Promise<string> {
  const from = term.output.length;
  term.type("j");
  await sleep(300);
  term.type("\r");
  await term.sees(raw("┃"), undefined, from);
  await sleep(300);
  const run = shownRun(term, runs, from);
  if (run === undefined)
    throw new Error(`no card was drawn: ${JSON.stringify(term.output.slice(from))}`);
  return run;
}

/**
 * `o` on the open card: the screen is given to the agent of `run`. The alternate screen is kept, cleared,
 * with one line that names the agent, until the agent's own screen is drawn into it.
 */
async function opens(term: Term, run: string): Promise<number> {
  const away = term.output.length;
  term.type("o");
  const opening = raw(`opening kw-${run}…`);
  await term.sees(opening, 30_000, away);
  // The agent's line is looked for after that one: the card the TUI drew before it left shows the
  // agent's last line too.
  const line = term.output.indexOf(opening, away);
  await term.sees(`agent-of-${run}-ready`, 30_000, line);
  const shown = term.output.slice(line);
  // The line first, then the child clears the screen for what the agent shows.
  const cleared = shown.indexOf(CLEAR);
  expect(cleared).toBeGreaterThan(0);
  expect(shown.indexOf(`agent-of-${run}-ready`)).toBeGreaterThan(cleared);
  expect(term.output.slice(away)).not.toContain(ALT_OFF);
  return away;
}

/**
 * The screen is back: the alternate screen, the hidden cursor and bracketed paste are on again, in that
 * order. Since `away` (the key `o`) the alternate screen was not left once and the child wrote no line of
 * its own: the shell behind was never seen.
 */
async function screenIsBack(term: Term, from: number, away = from): Promise<number> {
  await term.sees(ALT_ON, undefined, from);
  const at = term.output.indexOf(ALT_ON, from);
  expect(term.output.slice(away, at)).not.toContain(ALT_OFF);
  expect(term.output.slice(away, at)).not.toContain("[detached:");
  expect(term.output.slice(away, at)).not.toContain("[ended:");
  await term.sees(CURSOR_OFF, undefined, at);
  await term.sees(PASTE_ON, undefined, at);
  // A whole frame was drawn after it, and the alternate screen was not left again.
  await term.sees("RUNNING", undefined, at);
  expect(term.output.slice(at)).not.toContain(ALT_OFF);
  return at;
}

/** `q` ends the screen: a key was taken without a line end, so the terminal is raw again. */
async function quits(term: Term): Promise<void> {
  const from = term.output.length;
  term.type("q");
  const end = await term.ended(20_000);
  expect(end.exitCode).toBe(0);
  expect(term.output.slice(from)).toContain(ALT_OFF);
}

describe("the TUI hands its terminal to a run's agent and takes it back", () => {
  ptyTest(
    "t47_real_tui_returns_to_the_same_place",
    async () => {
      const s = await scene("echo agent-of-$RUN-ready; exec cat");
      const run = await onSecondCard(s.term, s.runs);
      const id = s.sessions.get(run) ?? "";
      // The terminal is the agent's of the very run the card was about.
      const away = await opens(s.term, run);
      for (const other of s.runs.filter((r) => r !== run)) {
        expect(s.term.output.slice(away)).not.toContain(`agent-of-${other}-ready`);
      }
      s.term.type("typed-in\r");
      await s.term.sees("typed-in\r\ntyped-in", undefined, away);
      const leaving = s.term.output.length;
      s.term.type(DETACH);
      const back = await screenIsBack(s.term, leaving, away);
      // The same run is selected and its card is open, with the notice of the return.
      await s.term.sees(raw(`${run} · one`), undefined, back);
      await s.term.sees(raw("┃"), undefined, back);
      await s.term.sees(`Back from kw-${run}`, undefined, back);
      expect(shownRun(s.term, s.runs, back)).toBe(run);
      // The agent goes on, and a key is the screen's again.
      expect((await s.w.adapter().status(id)).state).toBe("running");
      await sleep(300);
      await quits(s.term);
      // The alternate screen was entered at the start and after the return, and left once, by `q`.
      expect(s.term.output.split(ALT_OFF).length - 1).toBe(1);
    },
    120_000,
  );

  ptyTest(
    "t47_real_tui_returns_when_the_agent_ends",
    async () => {
      const s = await scene("echo agent-of-$RUN-ready; read line; exit 3");
      const run = await onSecondCard(s.term, s.runs);
      const away = await opens(s.term, run);
      const leaving = s.term.output.length;
      // The agent ends while the person is in it: nothing is pressed to come back.
      s.term.type("go\r");
      const back = await screenIsBack(s.term, leaving, away);
      await s.term.sees(raw(`${run} · one`), undefined, back);
      await s.term.sees(raw("┃"), undefined, back);
      await s.term.sees("ended while you were in it", undefined, back);
      expect(shownRun(s.term, s.runs, back)).toBe(run);
      await sleep(300);
      await quits(s.term);
    },
    120_000,
  );

  ptyTest(
    "t47_real_tui_survives_a_double_detach_chord",
    async () => {
      const s = await scene("echo agent-of-$RUN-ready; exec cat");
      const run = await onSecondCard(s.term, s.runs);
      const id = s.sessions.get(run) ?? "";
      const away = await opens(s.term, run);
      const leaving = s.term.output.length;
      // The chord twice in a row: the second lands while the terminal is between the two programs,
      // where it is the terminal's QUIT key or a byte nobody asked for. The screen lives either way.
      s.term.type(`${DETACH}${DETACH}`);
      const back = await screenIsBack(s.term, leaving, away);
      await s.term.sees(raw(`${run} · one`), undefined, back);
      await sleep(1_000);
      expect(s.term.exit).toBeUndefined();
      expect(shownRun(s.term, s.runs, back)).toBe(run);
      expect((await s.w.adapter().status(id)).state).toBe("running");
      await quits(s.term);
    },
    120_000,
  );

  ptyTest(
    "t47_real_tui_keeps_its_screen_when_the_agent_switches_screens",
    async () => {
      // The agent's program enters an alternate screen of its own, and leaves it when it ends: neither
      // switch reaches the terminal, which stays on the one the TUI keeps.
      const s = await scene(
        "printf '\\033[?1049h\\033[?1000h'; echo agent-of-$RUN-ready; read line; printf '\\033[?1000l\\033[?1049l'; echo agent-left-its-screen; read again; exit 0",
      );
      const run = await onSecondCard(s.term, s.runs);
      const away = await opens(s.term, run);
      s.term.type("go\r");
      await s.term.sees("agent-left-its-screen", undefined, away);
      expect(s.term.output.slice(away)).not.toContain(ALT_OFF);
      expect(s.term.output.slice(away)).not.toContain(ALT_ON);
      const leaving = s.term.output.length;
      s.term.type(DETACH);
      const back = await screenIsBack(s.term, leaving, away);
      await s.term.sees(`Back from kw-${run}`, undefined, back);
      await sleep(300);
      await quits(s.term);
      expect(s.term.output.split(ALT_OFF).length - 1).toBe(1);
    },
    120_000,
  );

  ptyTest(
    "t47_real_tui_resize_while_attached_reaches_the_agent",
    async () => {
      const s = await scene(
        "trap 'echo \"size:$(stty size)\"' WINCH; echo agent-of-$RUN-ready; while :; do sleep 0.1; done",
        { cols: 140, rows: 40 },
      );
      const run = await onSecondCard(s.term, s.runs);
      // The screen drew at the terminal's first size.
      expect(s.term.output).toContain("\u001b[40;1H");
      const away = await opens(s.term, run);
      // The outer terminal is resized while the screen is away: the agent's terminal gets the new size.
      s.term.resize(100, 30);
      await s.term.sees("size:30 100", 30_000, away);
      const leaving = s.term.output.length;
      s.term.type(DETACH);
      const back = await screenIsBack(s.term, leaving, away);
      // And the screen draws at it after the return: thirty rows, not forty.
      await s.term.sees("\u001b[30;1H", undefined, back);
      await sleep(500);
      expect(s.term.output.slice(back)).not.toContain("\u001b[31;1H");
      await quits(s.term);
    },
    120_000,
  );
});

/**
 * The launcher on a real terminal: the worker of a run is started through the one launcher
 * (`createSessionWorkerLauncher`) with the real adapter, whose holder is the built artifact on Node, and
 * the program it finds as `claude` is the scripted fake terminal agent of the testkit. The state base is
 * the default one of a home folder of the test's own (no `KODEL_STATE_DIR`), as on a person's machine:
 * what the agent's shell runs finds the session records where a person's commands would.
 */
const WORKER_PIPELINE = [
  "name: one",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write it",
  "  - slug: approve",
  "    kind: human",
  "    prompt: ok?",
  "  - slug: impl",
  "    kind: agent",
  "    prompt: implement it",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: impl }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

const ENGINE_REFUSAL = "it will not run from a command the engine runs";
const PASTE_OFF = "\u001b[?2004l";

interface WorkerScene {
  root: string;
  env: Record<string, string>;
  adapter: PipesSessionAdapter;
  agent: FakeTerminalAgent;
  pipelines: LocalPipelineHost;
  /** A launcher as a starter builds one: every call reads the records again. */
  launcher(): WorkerLauncher;
  /** A shell a person would type `kodel` into, in a terminal of the test's own. */
  shell(cols?: number): Promise<Term>;
  /** A run of the pipeline; `atGate` drives it to its human step first, as its agent would. */
  run(task: string, atGate?: boolean): Promise<LocalRun>;
  /** The pids a record names: its holder and the process the holder started. */
  pids(id: string): Promise<{ holder: number; child: number }>;
  /** Pids to end when the test is over, whatever happened in it. */
  strays: number[];
}

const scenes: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  for (const scene of scenes.splice(0)) await scene.dispose();
});

async function workerScene(agentOptions: Partial<FakeTerminalAgentOptions> = {}) {
  const top = shortDir("kd-w-");
  const root = join(top, "project");
  const home = join(top, "home");
  const base = join(home, ".kodel");
  mkdirSync(join(root, ".kodel", "pipelines"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(root, ".kodel", "pipelines", "one.yaml"), WORKER_PIPELINE);
  writeFileSync(join(root, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
  writeFileSync(join(root, ".gitignore"), ".kodel/runs\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");

  // `kodel` beside the agent: what a person has on PATH, as the agent's shell would spell it.
  const agent = writeFakeTerminalAgent({
    dir: join(top, "bin"),
    shims: { kodel: ["node", ARTIFACT] },
    ...agentOptions,
  });
  const env: Record<string, string> = {
    PATH: `${agent.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home,
    TERM: "xterm-256color",
    PS1: "$ ",
  };
  const adapter = new PipesSessionAdapter({
    base,
    root,
    holder: { exec: "node", args: [ARTIFACT, "session-holder", "holder"] },
    intermediate: { exec: "node", args: [ARTIFACT, "session-holder"] },
    // The adapter runs here, under Bun; the holder it starts is Node, which the availability check proved.
    ptyProbe: () => ({ ok: true }),
    pollMs: 25,
  });
  const pipelines = new LocalPipelineHost({ root, heartbeatMs: 0, environment: env });
  const host = new Host();
  hosts.push(host);
  const strays: number[] = [];
  const scene: WorkerScene = {
    root,
    env,
    adapter,
    agent,
    pipelines,
    strays,
    launcher: () =>
      createSessionWorkerLauncher({
        adapter,
        self: { exec: "node", args: [ARTIFACT] },
        root,
        stateBase: base,
        environment: env,
        rules: [],
        servedTools: ["pipeline_next_step", "pipeline_complete_step"],
        which: (name) => findOnPath(name, env),
        exec: execChild,
        platform: process.platform,
        clock: Date.now,
        uuid: () => randomUUID(),
        ptyProbe: () => ({ ok: true }),
        engines: async () => ({ ok: true, engines: { claude: { worker: "terminal" } } }),
        // The agent is a fake: nothing of it asks about trust.
        readText: async () =>
          JSON.stringify({ projects: { "/": { hasTrustDialogAccepted: true } } }),
      }),
    async shell(cols = 200) {
      const term = await host.open("/bin/sh", [], { cwd: root, env, cols, rows: 50 });
      await term.sh("true");
      return term;
    },
    async run(task, atGate = false) {
      const started = await pipelines.start({ pipeline: "one", task, restart: true });
      const run = (await pipelines.open(started.run.runId)) as LocalRun | undefined;
      if (!run) throw new Error("the run was not made");
      if (atGate) {
        await run.nextStep();
        await run.completeStep("write", 1, "written");
        const answer = await run.nextStep();
        if (!("waiting" in answer)) {
          throw new Error(`the run is not at its gate: ${JSON.stringify(answer)}`);
        }
      }
      return run;
    },
    pids: (id) =>
      until(() => {
        const file = join(sessionDirOf(adapter.place, id), "status.json");
        if (!existsSync(file)) return undefined;
        const status = JSON.parse(readFileSync(file, "utf8")) as {
          state?: string;
          holder?: { pid: number };
          child?: { pid: number };
        };
        return status.state === "running" && status.holder && status.child
          ? { holder: status.holder.pid, child: status.child.pid }
          : undefined;
      }, `the record of ${id} to name its processes`),
  };
  scenes.push({
    async dispose() {
      for (const pid of strays) {
        for (const target of [-pid, pid]) {
          try {
            process.kill(target, "SIGKILL");
          } catch {
            // gone
          }
        }
      }
      for (const entry of await adapter.list().catch(() => [])) {
        await adapter.stop(entry.id).catch(() => {});
        await adapter.remove(entry.id).catch(() => {});
      }
      rmSync(top, { recursive: true, force: true });
    },
  });
  return scene;
}

/** Starts the worker of a run through the launcher and answers its record and the agent behind it. */
async function startWorker(s: WorkerScene, run: LocalRun, title: string) {
  const before = s.agent.starts().length;
  const { name } = await s.launcher().start({ runId: run.runId, workdir: s.root, title });
  expect(name).toBe(`kw-${run.runId}`);
  const [record] = await s.adapter.list({ name });
  if (!record) throw new Error(`no record named ${name}`);
  const started = await until(() => s.agent.starts()[before], "the agent to start");
  const pids = await s.pids(record.id);
  s.strays.push(pids.child, started.pid);
  return { name, id: record.id, record, agent: started, ...pids };
}

/** The person approves the gate of a run, at a shell of their own: the command asks, and `y` is typed. */
async function approve(shell: Term, runId: string): Promise<void> {
  const from = shell.begin(`${KODEL} gate approve ${runId}`);
  await shell.sees("[y/N]", 60_000, from);
  shell.type("y\r");
  const done = await shell.finished(from, 120_000);
  expect(done.code, done.shown).toBe(0);
}

const decided = async (run: LocalRun): Promise<boolean> =>
  (await run.journal()).some((record) => record.event === "gate_decided");

/** The decision of the run as the journal has it: what a resume is asked for. */
async function decisionIn(run: LocalRun) {
  const { decision } = decisionOf(await run.journal());
  if (decision === undefined) throw new Error("the journal has no decision");
  return decision;
}

const workerNames = async (s: WorkerScene): Promise<string[]> =>
  (await s.adapter.list()).map((entry) => entry.name ?? "").sort();

describe("a worker in a terminal of its own, started through the launcher", () => {
  ptyTest(
    "t47_real_terminal_worker_attach_detach_finish",
    async () => {
      const s = await workerScene({ modes: true });
      const run = await s.run("attach to the worker");
      const worker = await startWorker(s, run, "attach to the worker");
      // A terminal session with the agent record the starter wrote; the agent got the argv of the profile.
      expect(worker.record).toMatchObject({
        mode: "pty",
        status: { state: "running" },
        agent: { engine: "claude", source: "chosen" },
      });
      expect(worker.agent.session).toBe(worker.record.agent?.session ?? "");
      expect(worker.agent).toMatchObject({
        tty: true,
        engine: "1",
        stateDir: null,
        resumed: false,
      });
      expect(worker.agent.argv).toContain("--strict-mcp-config");
      expect(worker.agent.argv).not.toContain("-p");
      expect(worker.agent.argv[worker.agent.argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
      expect(worker.agent.prompt).toContain(run.runId);
      // The holder's child is the agent itself, as with the real program (spike criterion 10).
      expect(worker.child).toBe(worker.agent.pid);
      const launcher = s.launcher();
      expect(await launcher.attachable(run.runId)).toEqual({ ok: true, id: worker.id });

      // A person opens it, types, and leaves it.
      const shell = await s.shell();
      const from = shell.begin(`${KODEL} agent attach ${worker.name}`);
      await shell.sees(`fake-agent ready ${worker.agent.session}`, 30_000, from);
      shell.type("bg 300\r");
      const background = await until(
        () => s.agent.events().find((entry) => entry.event === "bg")?.child as number | undefined,
        "the agent to leave a child in the background",
      );
      s.strays.push(background);
      shell.type("hello agent\r");
      await shell.sees("agent heard: hello agent", undefined, from);
      const leaving = shell.output.length;
      shell.type(DETACH);
      const done = await shell.finished(from);
      expect(done.code).toBe(0);
      expect(shell.output.slice(leaving)).toContain(`[detached: ${worker.name}]`);
      // The modes the agent switched on are reset for the person's shell.
      expect(shell.output.slice(leaving)).toContain(ALT_OFF);
      expect(shell.output.slice(leaving)).toContain(PASTE_OFF);
      // The session runs on, with what it started.
      expect((await s.adapter.status(worker.id)).state).toBe("running");
      expect(alive(worker.agent.pid)).toBe(true);
      expect(alive(background)).toBe(true);
      // Nothing was typed into it by kodel: the agent heard only what the person typed.
      expect(shell.output.slice(from).match(/agent heard: /g)?.length).toBe(1);

      // `finish` stops it at once, with the processes it started.
      await launcher.finish(run.runId);
      expect(await s.adapter.status(worker.id)).toMatchObject({
        state: "killed",
        reason: "stopped",
        // kodel ended it because its run was over: the stop record does not name the person
        stoppedBy: "finish",
      });
      expect((await launcher.statuses([run.runId])).get(run.runId)?.stopped).toBeUndefined();
      await until(
        () => !alive(worker.agent.pid) && !alive(background),
        "the agent and its background child to end",
      );
      // A second finish, of a session that is already stopped, is no error; nothing is attachable.
      await launcher.finish(run.runId);
      expect((await launcher.attachable(run.runId)).ok).toBe(false);
      expect(await workerNames(s)).toEqual([worker.name]);
    },
    180_000,
  );

  ptyTest(
    "t47_real_worker_shell_cannot_decide",
    async () => {
      const s = await workerScene();
      const run = await s.run("decide for me", true);
      const worker = await startWorker(s, run, "decide for me");
      // The person looks on from a terminal of their own; what is typed there is the agent's input.
      const shell = await s.shell(250);
      const from = shell.begin(`${KODEL} agent attach ${worker.name}`);
      await shell.sees("fake-agent ready", 30_000, from);
      const gate = `gate approve ${run.runId}`;
      // Each command runs in the agent's shell, on the agent's terminal. The last one gets a `y` typed
      // after it, for a question that must never come.
      const commands: [string, string, string?][] = [
        [`kodel ${gate}`, ENGINE_REFUSAL],
        [`env -u KODEL_ENGINE kodel ${gate}`, INSIDE_SESSION_REFUSAL],
        [`node ${ARTIFACT} ${gate}`, ENGINE_REFUSAL],
        [`env -u KODEL_ENGINE node ${ARTIFACT} ${gate}`, INSIDE_SESSION_REFUSAL],
        [`sh -c 'env -u KODEL_ENGINE kodel ${gate}'`, INSIDE_SESSION_REFUSAL, "y\r"],
      ];
      for (const [command, refusal, answer] of commands) {
        const at = shell.output.length;
        shell.type(`!${command}\r${answer ?? ""}`);
        await shell.sees(/\[exit \d+\]/, 60_000, at);
        const shown = shell.output.slice(at);
        expect(shown, command).toContain(refusal);
        expect(shown, command).toContain("[exit 1]");
        expect(shown, command).not.toContain("[y/N]");
        expect(await decided(run), command).toBe(false);
        if (answer !== undefined) {
          // The `y` was nobody's answer: it reached the agent as a line of its own.
          await shell.sees("agent heard: y", 30_000, at);
        }
      }
      expect(s.agent.events().filter((entry) => entry.event === "ran").length).toBe(
        commands.length,
      );
      const answer = await run.inspect();
      expect("waiting" in answer).toBe(true);
      shell.type(DETACH);
      await shell.finished(from);
      // The same command from the person's own shell decides: the gate was there to be decided.
      await approve(shell, run.runId);
      expect(await decided(run)).toBe(true);
    },
    240_000,
  );

  ptyTest(
    "t47_real_orphan_is_not_doubled",
    async () => {
      const s = await workerScene({ ignoreHangup: true });
      const run = await s.run("outlive the holder", true);
      const worker = await startWorker(s, run, "outlive the holder");
      // The holder is killed; the agent ignores the hangup of its terminal and lives on.
      process.kill(worker.holder, "SIGKILL");
      await until(
        async () => (await s.adapter.status(worker.id)).state === "lost",
        "the record to say lost",
      );
      await sleep(1_500);
      expect(alive(worker.agent.pid)).toBe(true);
      expect(await s.adapter.status(worker.id)).toMatchObject({ state: "lost", childAlive: true });
      const seen = (await s.launcher().statuses([run.runId])).get(run.runId);
      expect(seen).toMatchObject({ state: "lost", childAlive: true, terminal: true });
      expect(serveWorkerOf(seen as WorkerStatus).childAlive).toBe(true);
      // The person decides. No second agent is started for the run while the first one runs.
      await approve(await s.shell(), run.runId);
      const decision = await decisionIn(run);
      const resume = () =>
        s.launcher().resume({
          runId: run.runId,
          workdir: s.root,
          sessionId: worker.agent.session ?? "",
          decision,
        });
      await expect(resume()).rejects.toThrow(
        `its process still runs without a holder; stop it: kodel agent stop ${worker.id}`,
      );
      expect(await workerNames(s)).toEqual([worker.name]);
      expect(s.agent.starts().length).toBe(1);
      // Once the process is gone the ordinary rule applies: the worker ended at its wait, and is resumed.
      process.kill(worker.agent.pid, "SIGKILL");
      await until(
        async () => (await s.adapter.status(worker.id)).childAlive !== true,
        "the record to see its process gone",
      );
      const { name } = await resume();
      expect(name).toBe(`kw-${run.runId}-d${decision.seq}`);
      const resumed = await until(() => s.agent.starts()[1], "the resumed agent to start");
      s.strays.push(resumed.pid);
      expect(resumed).toMatchObject({ session: worker.agent.session, resumed: true });
    },
    240_000,
  );

  ptyTest(
    "t47_real_holder_and_agent_gone_at_a_wait_is_resumed",
    async () => {
      const s = await workerScene();
      const run = await s.run("come back after a reboot", true);
      const worker = await startWorker(s, run, "come back after a reboot");
      // A reboot: the holder and the agent are both gone, and nobody recorded an end.
      process.kill(worker.holder, "SIGKILL");
      try {
        process.kill(-worker.child, "SIGKILL");
      } catch {
        // the hangup of its terminal ended it first
      }
      await until(async () => {
        const status = await s.adapter.status(worker.id);
        return status.state === "lost" && status.childAlive !== true;
      }, "the record to say lost with nothing left of it");
      expect(alive(worker.agent.pid)).toBe(false);
      // The state is read again by a starter that knows nothing of before, and the person decides.
      await approve(await s.shell(), run.runId);
      const decision = await decisionIn(run);
      const launcher = s.launcher();
      const seen = (await launcher.statuses([run.runId])).get(run.runId);
      expect(seen).toMatchObject({ state: "lost", terminal: true });
      expect(seen?.childAlive).toBeUndefined();
      expect(seen?.sessionId).toBe(worker.agent.session ?? "");
      const input = {
        runId: run.runId,
        workdir: s.root,
        sessionId: seen?.sessionId ?? "",
        decision,
      };
      const { name } = await launcher.resume(input);
      expect(name).toBe(`kw-${run.runId}-d${decision.seq}`);
      // One new session, in a terminal, that continues the conversation of the first.
      const resumed = await until(() => s.agent.starts()[1], "the resumed agent to start");
      s.strays.push(resumed.pid);
      expect(resumed).toMatchObject({ session: worker.agent.session, resumed: true, tty: true });
      const [record] = await s.adapter.list({ name });
      expect(record).toMatchObject({
        mode: "pty",
        status: { state: "running" },
        agent: { engine: "claude", session: worker.agent.session, resumes: worker.id },
      });
      // Once: a second resume of the same decision starts nothing.
      const again = await s
        .launcher()
        .resume(input)
        .then(
          () => "started",
          (error: unknown) => (error instanceof SessionError ? error.code : String(error)),
        );
      expect(again).toBe("NAME_TAKEN");
      expect(await workerNames(s)).toEqual([worker.name, name].sort());
      expect(s.agent.starts().length).toBe(2);
    },
    240_000,
  );

  ptyTest(
    "t47_real_holder_told_to_end_at_a_wait_is_not_a_stop",
    async () => {
      const s = await workerScene();
      const run = await s.run("come back after a shutdown", true);
      const worker = await startWorker(s, run, "come back after a shutdown");
      // A shutdown: the holder is told to end, and nobody ran `kodel agent stop`. It stops its agent and
      // records the end itself.
      process.kill(worker.holder, "SIGTERM");
      await until(
        async () => (await s.adapter.status(worker.id)).state === "killed",
        "the record to say killed",
      );
      await until(() => !alive(worker.holder) && !alive(worker.agent.pid), "both to end");
      const status = await s.adapter.status(worker.id);
      expect(status).toMatchObject({ state: "killed", signal: "SIGTERM" });
      expect(status.reason).toBeUndefined();
      // Not a worker the person stopped, for the screen and for the daemon.
      const waiting = (await s.launcher().statuses([run.runId])).get(run.runId) as WorkerStatus;
      expect(waiting).toMatchObject({ state: "killed", terminal: true, endedBy: "signal" });
      expect(waiting.stopped).toBeUndefined();
      expect(waiting.label).toBe("killed (SIGTERM)");
      const verdict = async () =>
        resumeVerdict(
          {
            runId: run.runId,
            status: "running",
            waitsForPerson: "waiting" in (await run.inspect()),
            marks: decisionOf(await run.journal()),
          },
          // The scene's run is at its gate before its worker starts: the rule is asked as for a worker
          // that was there when the wait began.
          serveWorkerOf({ ...waiting, started: 0 }),
          { refuseMoved: true },
        );
      expect(await verdict()).toEqual({ kind: "no", why: "waiting_person" });
      // The person decides: the daemon's rule resumes it (it would answer `stopped` for a stopped one).
      await approve(await s.shell(), run.runId);
      const decision = await decisionIn(run);
      expect(await verdict()).toMatchObject({ kind: "resume", seq: decision.seq });
      // The same record with a person's stop on it is the one the daemon leaves alone.
      expect(
        resumeVerdict(
          {
            runId: run.runId,
            status: "running",
            waitsForPerson: false,
            marks: decisionOf(await run.journal()),
          },
          serveWorkerOf({ ...waiting, started: 0, stopped: true, endedBy: "stopped" }),
          { refuseMoved: true },
        ),
      ).toEqual({ kind: "no", why: "stopped" });
      const { name } = await s.launcher().resume({
        runId: run.runId,
        workdir: s.root,
        sessionId: waiting.sessionId ?? "",
        decision,
      });
      expect(name).toBe(`kw-${run.runId}-d${decision.seq}`);
      const resumed = await until(() => s.agent.starts()[1], "the resumed agent to start");
      s.strays.push(resumed.pid);
      expect(resumed).toMatchObject({ session: worker.agent.session, resumed: true, tty: true });
    },
    240_000,
  );

  ptyTest(
    "t47_real_persons_stop_of_what_a_final_record_left_is_left_to_the_person",
    async () => {
      const s = await workerScene({ ignoreHangup: true });
      const run = await s.run("be stopped after the holder's own end", true);
      const worker = await startWorker(s, run, "be stopped after the holder's own end");
      // The holder is gone and its agent lives on (it ignores the hangup of its terminal). The record is the
      // one a holder leaves that had written its own end before it went: a timeout, with the child still there.
      process.kill(worker.holder, "SIGKILL");
      await until(() => !alive(worker.holder), "the holder to end");
      const statusFile = join(sessionDirOf(s.adapter.place, worker.id), "status.json");
      const { sock: _sock, ...recorded } = JSON.parse(readFileSync(statusFile, "utf8"));
      writeFileSync(
        statusFile,
        JSON.stringify({ ...recorded, state: "killed", reason: "timeout", since: Date.now() }),
      );
      await sleep(1_500);
      expect(alive(worker.agent.pid)).toBe(true);
      const left = await s.adapter.status(worker.id);
      expect(left).toMatchObject({ state: "killed", reason: "timeout", childAlive: true });
      expect(left.stoppedBy).toBeUndefined();
      // The person's command ends what is left of it.
      const shell = await s.shell();
      const from = shell.begin(`${KODEL} agent stop ${worker.id}`);
      await shell.sees("[y/N]", 60_000, from);
      shell.type("y\r");
      const done = await shell.finished(from, 120_000);
      expect(done.code, done.shown).toBe(0);
      expect(done.shown).toContain(`${worker.id}: stopped`);
      await until(() => !alive(worker.agent.pid), "the agent to end");
      // The record keeps the end its holder wrote; the status says a person stopped it, and so does every
      // layer up to the view the daemon's rule reads.
      const after = await s.adapter.status(worker.id);
      expect(after).toMatchObject({ state: "killed", reason: "timeout", stoppedBy: "person" });
      expect(after.childAlive).not.toBe(true);
      const seen = (await s.launcher().statuses([run.runId])).get(run.runId) as WorkerStatus;
      expect(seen).toMatchObject({
        state: "killed",
        stopped: true,
        terminal: true,
        endedBy: "timeout",
        label: "stopped (after timeout)",
      });
      expect(seen.childAlive).toBeUndefined();
      const verdict = async (opts: { refuseMoved: boolean; resumeStopped?: boolean }) =>
        resumeVerdict(
          {
            runId: run.runId,
            status: "running",
            waitsForPerson: "waiting" in (await run.inspect()),
            marks: decisionOf(await run.journal()),
          },
          // As in the scene above: the run was at its gate before its worker started.
          serveWorkerOf({ ...seen, started: 0 }),
          opts,
        );
      expect(await verdict({ refuseMoved: true })).toEqual({ kind: "no", why: "waiting_person" });
      // The person decides: the daemon leaves the worker to them, and the TUI offers the resume.
      await approve(shell, run.runId);
      const decision = await decisionIn(run);
      expect(await verdict({ refuseMoved: true })).toEqual({ kind: "no", why: "stopped" });
      expect(await verdict({ refuseMoved: false, resumeStopped: true })).toMatchObject({
        kind: "resume",
        seq: decision.seq,
      });
      expect(s.agent.starts().length).toBe(1);
    },
    240_000,
  );

  /** A worker whose program is a wrapper, the agent behind it; the holder is killed and the wrapper dies. */
  async function behindADeadWrapper(task: string) {
    const s = await workerScene({ wrapper: true, ignoreHangup: true });
    const run = await s.run(task, true);
    const worker = await startWorker(s, run, task);
    // The holder's child is the wrapper; the agent is another process, in the wrapper's group.
    expect(worker.child).not.toBe(worker.agent.pid);
    process.kill(worker.holder, "SIGKILL");
    await until(() => !alive(worker.child), "the wrapper to die with its terminal");
    await until(
      async () => (await s.adapter.status(worker.id)).state === "lost",
      "the record to say lost",
    );
    expect(alive(worker.agent.pid)).toBe(true);
    return { s, run, worker };
  }

  ptyTest(
    "t47_real_orphan_behind_a_wrapper_is_not_doubled",
    async () => {
      const { s, run, worker } = await behindADeadWrapper("stay behind the wrapper");
      // The recorded child is gone; a process of its group runs: the session is not over.
      expect(await s.adapter.status(worker.id)).toMatchObject({ state: "lost", childAlive: true });
      const seen = (await s.launcher().statuses([run.runId])).get(run.runId);
      expect(seen?.childAlive).toBe(true);
      await approve(await s.shell(), run.runId);
      const decision = await decisionIn(run);
      await expect(
        s.launcher().resume({
          runId: run.runId,
          workdir: s.root,
          sessionId: worker.agent.session ?? "",
          decision,
        }),
      ).rejects.toThrow("its process still runs without a holder");
      expect(await workerNames(s)).toEqual([worker.name]);
      expect(s.agent.starts().length).toBe(1);
      expect(alive(worker.agent.pid)).toBe(true);
    },
    240_000,
  );

  ptyTest(
    "t47_real_stop_leaves_an_agent_behind_a_dead_wrapper_to_the_person",
    async () => {
      const { s, run, worker } = await behindADeadWrapper("be stopped behind the wrapper");
      expect((await s.adapter.status(worker.id)).childAlive).toBe(true);
      // `rm` refuses it while the agent runs.
      await expect(s.adapter.remove(worker.id)).rejects.toMatchObject({ code: "STILL_RUNNING" });
      // The person's command signals nothing of a group without its leader: it names the agent's process and
      // says what to do.
      const stop = async () => {
        const shell = await s.shell();
        const from = shell.begin(`${KODEL} agent stop ${worker.id}`);
        await shell.sees("[y/N]", 60_000, from);
        shell.type("y\r");
        const done = await shell.finished(from, 120_000);
        expect(done.code, done.shown).toBe(0);
        return done.shown;
      };
      const first = await stop();
      expect(first).toContain(`${worker.id}: not stopped`);
      expect(first).toContain("nothing was signalled");
      expect(first).toContain(`${worker.agent.pid} (`);
      expect(first).toContain("kill <pid>");
      expect(alive(worker.agent.pid)).toBe(true);
      const held = await s.adapter.status(worker.id);
      expect(held).toMatchObject({ childAlive: true, group: "leaderless", stoppedBy: "person" });
      await expect(s.adapter.remove(worker.id)).rejects.toMatchObject({ code: "STILL_RUNNING" });
      // The person ends it, and the same command settles the record.
      process.kill(worker.agent.pid, "SIGKILL");
      await until(() => !alive(worker.agent.pid), "the agent to end");
      const second = await stop();
      expect(second).toContain(`${worker.id}: stopped`);
      expect(second).not.toContain("nothing was signalled");
      const after = await s.adapter.status(worker.id);
      expect(after.childAlive).not.toBe(true);
      expect(after.state === "running" || after.state === "starting").toBe(false);
      // An ended session for every rule: it is listed as stopped, and it can be removed.
      const listed = (await s.launcher().statuses([run.runId])).get(run.runId);
      expect(listed?.childAlive).toBeUndefined();
      expect(listed?.stopped).toBe(true);
      await s.adapter.remove(worker.id);
      expect(await s.adapter.list()).toEqual([]);
    },
    240_000,
  );
});
