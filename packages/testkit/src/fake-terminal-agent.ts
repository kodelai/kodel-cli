/**
 * A scripted fake terminal agent (T-45): a program that stands for an interactive coding agent in a
 * terminal session, for the tests that start a worker through the real launcher on a real PTY. It is
 * written to a folder as the agent's own program name (`claude`), so the launcher finds it on `PATH`
 * and starts it with the argv of the real profile; it runs on plain Node.
 *
 * What it does: it answers the profile's probes (`auth status --json`, `--version`); started as an
 * agent it writes one line about its start to a log (its argv, its conversation id, whether it was
 * resumed, the marks of its environment), prints `fake-agent ready <id>`, and then acts on the lines
 * typed into its terminal:
 *
 * - `!<command>`: runs the command through `sh -c` on its own terminal and prints `[exit <code>]`
 *   (a real agent's shell commands have no terminal; this is the stronger case, a command that has one);
 * - `bg [seconds]`: leaves a `sleep` running in the background, in a session of its own as a real
 *   agent's shell commands are, and prints `bg <pid>`;
 * - `quit [code]`: ends;
 * - anything else: `agent heard: <line>`.
 *
 * Options make it ignore the hangup of its terminal (an agent that outlives its holder), sit behind a
 * wrapper that is the holder's child (an agent left behind a wrapper that died), switch terminal modes
 * on at its start, and act on lines of its own at the start.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeTerminalAgentOptions {
  /** The folder the programs are written to: put it first on `PATH`. */
  dir: string;
  /** The program's name, as the agent's profile spells it. */
  name?: string;
  /** The Node that runs it. */
  node?: string;
  /** Other commands beside it: a name and the argv it stands for (`kodel: ["node", "<artifact>"]`). */
  shims?: Record<string, readonly string[]>;
  /** It ignores the hangup of its terminal and lives on when its holder is killed. */
  ignoreHangup?: boolean;
  /**
   * The program is a shell that starts the agent behind it and waits: the holder's child is the wrapper,
   * and the agent, a background job of a shell without job control, stays in the wrapper's process group
   * and does not read the terminal.
   */
  wrapper?: boolean;
  /** It enters the alternate screen and turns bracketed paste on at its start, and leaves both at `quit`. */
  modes?: boolean;
  /** Lines it acts on at its start, as if they were typed. */
  startup?: readonly string[];
}

/** One start of the agent, as its log has it. */
export interface FakeTerminalAgentStart {
  pid: number;
  argv: string[];
  cwd: string;
  /** The id of the conversation (`--session-id` or `--resume`). */
  session?: string;
  resumed: boolean;
  /** The prompt, as the argv carried it. */
  prompt?: string;
  /** `KODEL_ENGINE` and `KODEL_STATE_DIR` of its environment; `null` when absent. */
  engine: string | null;
  stateDir: string | null;
  /** Whether it has a terminal on its input. */
  tty: boolean;
}

export interface FakeTerminalAgent {
  /** The folder to put first on `PATH`. */
  bin: string;
  /** The program the launcher finds. */
  program: string;
  /** Every start so far, oldest first. */
  starts(): FakeTerminalAgentStart[];
  /** Every line of the log (`start`, `ran`, `bg`, `hangup`), oldest first. */
  events(): Record<string, unknown>[];
}

const quote = (part: string): string => `'${part.replaceAll("'", `'\\''`)}'`;

/** The agent itself: plain JavaScript for Node, with its options read from the file beside it. */
const SCRIPT = String.raw`import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const config = JSON.parse(readFileSync(new URL("./fake-terminal-agent.json", import.meta.url), "utf8"));
const argv = process.argv.slice(2);

// The probes of the profile: answered and done.
if (argv[0] === "auth" && argv[1] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "fake" }) + "\n");
  process.exit(0);
}
if (argv[0] === "--version") {
  process.stdout.write("0.0.0 (fake terminal agent)\n");
  process.exit(0);
}

const valueOf = (flag) => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
};
const dashes = argv.indexOf("--");
const prompt = dashes >= 0 ? argv[dashes + 1] : undefined;
const resumed = valueOf("--resume") !== undefined;
const session = valueOf("--session-id") ?? valueOf("--resume");
const log = (entry) => {
  try {
    appendFileSync(config.log, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
  } catch {
    // the folder of the test is gone
  }
};
// A terminal that went away answers a write with an error: there is nobody left to show it to.
process.stdout.on("error", () => {});
process.stdin.on("error", () => {});
const out = (text) => {
  try {
    process.stdout.write(text);
  } catch {
    // gone
  }
};

log({
  event: "start",
  argv,
  cwd: process.cwd(),
  ...(session === undefined ? {} : { session }),
  resumed,
  ...(prompt === undefined ? {} : { prompt }),
  engine: process.env.KODEL_ENGINE ?? null,
  stateDir: process.env.KODEL_STATE_DIR ?? null,
  tty: process.stdin.isTTY === true,
});
if (config.ignoreHangup) process.on("SIGHUP", () => log({ event: "hangup" }));
if (config.modes) out("\u001b[?1049h\u001b[?2004h");
out("fake-agent ready " + (session ?? "-") + (resumed ? " (resumed)" : "") + "\r\n");
if (prompt !== undefined) out("prompt: " + (prompt.trim().split("\n")[0] ?? "") + "\r\n");

const act = (line) => {
  const text = line.trim();
  if (text === "") return;
  if (text.startsWith("!")) {
    const result = spawnSync("sh", ["-c", text.slice(1)], { stdio: "inherit" });
    log({ event: "ran", command: text.slice(1), status: result.status });
    out("[exit " + (result.status ?? result.signal) + "]\r\n");
  } else if (text === "bg" || text.startsWith("bg ")) {
    const child = spawn("sleep", [text.split(/\s+/)[1] ?? "300"], { stdio: "ignore", detached: true });
    child.unref();
    log({ event: "bg", child: child.pid });
    out("bg " + child.pid + "\r\n");
  } else if (text === "quit" || text.startsWith("quit ")) {
    if (config.modes) out("\u001b[?2004l\u001b[?1049l");
    process.exit(Number(text.split(/\s+/)[1] ?? 0));
  } else {
    out("agent heard: " + text + "\r\n");
  }
};

for (const line of config.startup ?? []) act(line);
// It stays until it is told to quit, stopped, or its terminal goes (unless it ignores that).
setInterval(() => {}, 1_000);
if (process.stdin.isTTY === true) {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", act);
  lines.on("close", () => {
    if (!config.ignoreHangup) process.exit(0);
  });
}
`;

/** Writes the agent and its program into `options.dir`, and answers how a test finds and reads it. */
export function writeFakeTerminalAgent(options: FakeTerminalAgentOptions): FakeTerminalAgent {
  const { dir } = options;
  const name = options.name ?? "claude";
  const node = options.node ?? "node";
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "fake-terminal-agent.mjs");
  const log = join(dir, "fake-terminal-agent.log");
  writeFileSync(script, SCRIPT);
  writeFileSync(
    join(dir, "fake-terminal-agent.json"),
    JSON.stringify({
      log,
      ignoreHangup: options.ignoreHangup === true,
      modes: options.modes === true,
      startup: [...(options.startup ?? [])],
    }),
  );
  const executable = (file: string, lines: string[]): string => {
    const path = join(dir, file);
    writeFileSync(path, `${["#!/bin/sh", ...lines].join("\n")}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const run = `${quote(node)} ${quote(script)} "$@"`;
  const program = executable(
    name,
    options.wrapper
      ? // The probes are answered by the agent in the foreground; started as an agent it is put behind
        // the wrapper, which waits for it and dies with its terminal.
        ['case "$1" in auth|--version) exec ' + run + " ;; esac", `${run} &`, "wait"]
      : [`exec ${run}`],
  );
  for (const [shim, argv] of Object.entries(options.shims ?? {})) {
    executable(shim, [`exec ${argv.map(quote).join(" ")} "$@"`]);
  }
  const events = (): Record<string, unknown>[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  return {
    bin: dir,
    program,
    events,
    starts: () =>
      events()
        .filter((entry) => entry.event === "start")
        .map(({ event: _event, ...start }) => start as unknown as FakeTerminalAgentStart),
  };
}
