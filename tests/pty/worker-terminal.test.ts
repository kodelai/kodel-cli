/**
 * The TUI's `o` on a real terminal (TASK-EKAV, T-45): the built `kodel tui` on Node in a terminal of the
 * test's own, two runs of a project, and for each run a session `kw-<run>` in a terminal of its own with a
 * shell script standing for the agent. The screen hands its terminal to `kodel agent attach` and takes it
 * back where it was.
 */
import { afterEach, describe, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalPipelineHost } from "../../packages/local/src";
import { ARTIFACT, Host, realPtyTests, sleep, type Term, type World, world } from "./harness";

const real = realPtyTests();
const ptyTest = real.test;

const ALT_ON = "\u001b[?1049h";
const ALT_OFF = "\u001b[?1049l";
const CURSOR_OFF = "\u001b[?25l";
const PASTE_ON = "\u001b[?2004h";
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
  "",
].join("\n");

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
  await term.sees("◆ running", 30_000);
  return { w, term, runs, sessions };
}

/** The run whose card the screen shows, read from what was drawn since `from`. */
const shownRun = (term: Term, runs: readonly string[], from: number): string | undefined => {
  const drawn = term.output.slice(from);
  let found: { run: string; at: number } | undefined;
  for (const run of runs) {
    // The run's id is on its card only: the rows of the list show titles.
    const at = drawn.lastIndexOf(`${run} · one`);
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
  await term.sees("┃", undefined, from);
  await sleep(300);
  const run = shownRun(term, runs, from);
  if (run === undefined)
    throw new Error(`no card was drawn: ${JSON.stringify(term.output.slice(from))}`);
  return run;
}

/** The screen is back: the alternate screen, the hidden cursor and bracketed paste are on again, in that order. */
async function screenIsBack(term: Term, from: number): Promise<number> {
  await term.sees(ALT_ON, undefined, from);
  const at = term.output.indexOf(ALT_ON, from);
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
    "t45_real_tui_returns_to_the_same_place",
    async () => {
      const s = await scene("echo agent-of-$RUN-ready; exec cat");
      const run = await onSecondCard(s.term, s.runs);
      const id = s.sessions.get(run) ?? "";
      const away = s.term.output.length;
      s.term.type("o");
      // The screen is left, and the terminal is the agent's of the very run the card was about.
      await s.term.sees(`agent-of-${run}-ready`, 30_000, away);
      expect(s.term.output.slice(away)).toContain(ALT_OFF);
      for (const other of s.runs.filter((r) => r !== run)) {
        expect(s.term.output.slice(away)).not.toContain(`agent-of-${other}-ready`);
      }
      s.term.type("typed-in\r");
      await s.term.sees("typed-in\r\ntyped-in", undefined, away);
      const leaving = s.term.output.length;
      s.term.type(DETACH);
      await s.term.sees(`[detached: kw-${run}]`, undefined, leaving);
      const back = await screenIsBack(s.term, leaving);
      // The same run is selected and its card is open, with the notice of the return.
      await s.term.sees(`${run} · one`, undefined, back);
      await s.term.sees("┃", undefined, back);
      await s.term.sees(`Back from kw-${run}`, undefined, back);
      expect(shownRun(s.term, s.runs, back)).toBe(run);
      // The agent goes on, and a key is the screen's again.
      expect((await s.w.adapter().status(id)).state).toBe("running");
      await sleep(300);
      await quits(s.term);
    },
    120_000,
  );

  ptyTest(
    "t45_real_tui_returns_when_the_agent_ends",
    async () => {
      const s = await scene("echo agent-of-$RUN-ready; read line; exit 3");
      const run = await onSecondCard(s.term, s.runs);
      const away = s.term.output.length;
      s.term.type("o");
      await s.term.sees(`agent-of-${run}-ready`, 30_000, away);
      const leaving = s.term.output.length;
      // The agent ends while the person is in it: nothing is pressed to come back.
      s.term.type("go\r");
      await s.term.sees(`[ended: kw-${run}, exit 3]`, undefined, leaving);
      const back = await screenIsBack(s.term, leaving);
      await s.term.sees(`${run} · one`, undefined, back);
      await s.term.sees("┃", undefined, back);
      await s.term.sees("ended while you were in it", undefined, back);
      expect(shownRun(s.term, s.runs, back)).toBe(run);
      await sleep(300);
      await quits(s.term);
    },
    120_000,
  );

  ptyTest(
    "t45_real_tui_survives_a_double_detach_chord",
    async () => {
      const s = await scene("echo agent-of-$RUN-ready; exec cat");
      const run = await onSecondCard(s.term, s.runs);
      const id = s.sessions.get(run) ?? "";
      const away = s.term.output.length;
      s.term.type("o");
      await s.term.sees(`agent-of-${run}-ready`, 30_000, away);
      const leaving = s.term.output.length;
      // The chord twice in a row: the second lands while the terminal is between the two programs,
      // where it is the terminal's QUIT key or a byte nobody asked for. The screen lives either way.
      s.term.type(`${DETACH}${DETACH}`);
      await s.term.sees(`[detached: kw-${run}]`, undefined, leaving);
      const back = await screenIsBack(s.term, leaving);
      await s.term.sees(`${run} · one`, undefined, back);
      await sleep(1_000);
      expect(s.term.exit).toBeUndefined();
      expect(shownRun(s.term, s.runs, back)).toBe(run);
      expect((await s.w.adapter().status(id)).state).toBe("running");
      await quits(s.term);
    },
    120_000,
  );

  ptyTest(
    "t45_real_tui_resize_while_attached_reaches_the_agent",
    async () => {
      const s = await scene(
        "trap 'echo \"size:$(stty size)\"' WINCH; echo agent-of-$RUN-ready; while :; do sleep 0.1; done",
        { cols: 140, rows: 40 },
      );
      const run = await onSecondCard(s.term, s.runs);
      // The screen drew at the terminal's first size.
      expect(s.term.output).toContain("\u001b[40;1H");
      const away = s.term.output.length;
      s.term.type("o");
      await s.term.sees(`agent-of-${run}-ready`, 30_000, away);
      // The outer terminal is resized while the screen is away: the agent's terminal gets the new size.
      s.term.resize(100, 30);
      await s.term.sees("size:30 100", 30_000, away);
      const leaving = s.term.output.length;
      s.term.type(DETACH);
      await s.term.sees(`[detached: kw-${run}]`, undefined, leaving);
      const back = await screenIsBack(s.term, leaving);
      // And the screen draws at it after the return: thirty rows, not forty.
      await s.term.sees("\u001b[30;1H", undefined, back);
      await sleep(500);
      expect(s.term.output.slice(back)).not.toContain("\u001b[31;1H");
      await quits(s.term);
    },
    120_000,
  );
});
