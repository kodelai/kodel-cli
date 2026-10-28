/**
 * The commands. The ones that decide something (`gate`, `resume`, `ack`, `seal`) are for a person
 * at a terminal and are deliberately not MCP tools: the agent cannot call them. They also refuse to
 * run without a terminal and ask for a confirmation, so an agent with shell access cannot simply
 * type them; the deny rules in the agent's settings are a second line, not the only one.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  findProjectRoot,
  LocalPipelineHost,
  loadConfig,
  openTaskService,
  type ProjectRoot,
  resolveStoragePlace,
  type StoragePlace,
  scrubHome,
} from "@kodel-ai/local";
import { MAX_PAYLOAD_BYTES, runHook } from "@kodel-ai/local/hooks";
import {
  type Decision,
  KodelError,
  type NewTask,
  type RunState,
  type RunTaskLink,
  redactText,
  runSlug,
  type SubtaskRef,
  type Task,
  type TaskFilter,
  type TaskPatch,
  type TaskService,
  type TaskSummary,
  type ToolResult,
} from "@kodel-ai/pipeline-core";
import { Command, CommanderError } from "commander";
import pkg from "../package.json" with { type: "json" };
import { BUILD } from "./build-info";
import { describePendingChange, gateChangesText, gateCommentsText } from "./decide-text";
import {
  FEEDBACK_ENDPOINT,
  FEEDBACK_MESSAGE_MAX,
  type Fetch,
  feedbackContext,
  isFeedbackType,
  submitFeedback,
} from "./feedback";
import { formatProposal, formatReport } from "./format";
import { type Choice, InitError, runInit } from "./init";
import { dialogTimeoutFrom, noProjectHost, serveStdio } from "./mcp-server";
import { plain, UNSAFE_CODES } from "./plain";
import { formatTable } from "./table";
import {
  formatFailure,
  formatProblems,
  formatSchema,
  formatTask,
  formatTaskTable,
} from "./task-format";

export interface CliEnv {
  cwd: string;
  out(text: string): void;
  err(text: string): void;
  /** Whether a person is at a terminal: stdin and stdout are both a TTY. */
  interactive: boolean;
  /** Ask the person a yes/no question; the answer to an empty line is `defaultYes` (no unless given). */
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  /** Ask the person to pick any number of the choices; the answer is the values picked. */
  select(question: string, choices: Choice[]): Promise<string[]>;
  /** The environment the command runs in (`process.env`), looked at for the engine's marker. */
  environment?: Record<string, string | undefined>;
  /** For `feedback`: the HTTP client (the global `fetch` if none) and the text piped to stdin. */
  fetch?: Fetch;
  readStdin?(): Promise<string>;
  /** For `wait`: how often it looks at the run, in milliseconds (a second if none). */
  pollMs?: number;
  /** For `wait`: called once, when it is watching a run that waits (so a test knows when to decide). */
  onWatching?(): void;
}

/** A problem to report to the user without a stack trace. */
class UserError extends Error {}

/** How long a command waits for engine work it started (a build, say) before it lets go. */
const WORK_WAIT_MS = 30 * 60_000;

export { plain };

/**
 * How long `wait` stays when nobody decides. Long enough for a night, short enough not to live for
 * weeks; a shorter one would wake the agent again and again while the person is away.
 */
export const WAIT_TIMEOUT_S = 28_800;

/** How long `wait` looks for the journal record of a change it has seen in the state. */
const JOURNAL_GRACE_MS = 3000;

/** The exit code of `wait` that gave up: not 0 (it reported a decision) and not 1 (it failed). */
const WAIT_GAVE_UP = 2;

function wholeSeconds(text: string): number {
  if (!/^\d+$/.test(text.trim())) {
    throw new UserError(
      `--timeout is a whole number of seconds, 0 for no limit; "${plain(text)}" is not`,
    );
  }
  return Number(text);
}

function describeDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}min`;
  return `${seconds}s`;
}

/** Gives a command group its plural alias (`task` -> `tasks`); use it for every new group. */
export function withPlural(group: Command): Command {
  return group.alias(`${group.name()}s`);
}

/**
 * JSON for a terminal. `JSON.stringify` escapes the C0 controls but not the delete and C1 controls,
 * the characters that reorder text, or the line and paragraph separators: they are escaped here,
 * so `--json` of a task cannot move the cursor or reorder what a person reads.
 */
export function safeJson(value: unknown): string {
  let out = "";
  for (const char of JSON.stringify(value, null, 2)) {
    const code = char.codePointAt(0) ?? 0;
    const unsafe = code >= 0x7f && UNSAFE_CODES.some(([from, to]) => code >= from && code <= to);
    out += unsafe ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }
  return out;
}

function describeRun(state: RunState | undefined): string {
  if (!state) return "unreadable";
  const status = plain(String(state.status));
  if (state.status === "paused")
    return `paused (${plain(state.pause?.reason ?? "?")} at ${plain(state.pause?.node ?? "?")})`;
  const at = state.active.map((v) => `${plain(v.node)}#${v.attempt}`).join(", ");
  return at ? `${status} at ${at}` : status;
}

/** The run's slug: the one it was started with, or the name its task text would have given an older run. */
function slugOf(meta: { slug?: string; task: string }, state: RunState | undefined): string {
  return meta.slug ?? state?.slug ?? runSlug(undefined, meta.task);
}

function failIfRefused(decision: Decision): void {
  if (!decision.ok) {
    throw new UserError(`${decision.error.code}: ${plain(decision.error.message)}`);
  }
}

export async function runCli(argv: string[], env: CliEnv): Promise<number> {
  let exitCode = 0;
  const program = new Command();
  program
    .name("kodel")
    .description("Spec-driven pipelines inside your coding agent")
    .version(pkg.version)
    .option(
      "--root <dir>",
      "the project the pipelines belong to (default: the nearest folder above with a committed project config; KODEL_ROOT also sets it)",
    )
    .exitOverride()
    .configureOutput({ writeOut: env.out, writeErr: env.err });

  // Found once, the first time a command needs it; the notes go to stderr (stdout is the protocol of
  // `mcp` and the data of `--json`).
  let found: Promise<ProjectRoot> | undefined;
  const project = (): Promise<ProjectRoot> => {
    found ??= (async () => {
      const result = await findProjectRoot(env.cwd, {
        explicit: program.opts<{ root?: string }>().root,
        env: env.environment ?? {},
      });
      if (result.via === "worktree") {
        env.err(`kodel: using the project at ${plain(result.root)}: you are in a worktree of it\n`);
      } else if (result.climbed) {
        env.err(`kodel: using the project at ${plain(result.root)}: it is above this folder\n`);
      }
      return result;
    })();
    return found;
  };
  // Where the config says the history is kept. Asked once per command, the first time it is needed
  // (a command that reads a config the loader refuses says so once, not at every use); the server
  // asks again at each call that opens a run, through `watchStorage`, silently.
  const resolvePlace = async (silent: boolean): Promise<StoragePlace> => {
    const { root, dataDir } = await project();
    return resolveStoragePlace({
      root,
      dataDir,
      env: env.environment ?? {},
      // A config the loader refuses still names the place for a command that only reads; say so.
      ...(silent
        ? {}
        : {
            onConfigProblem: (message: string) =>
              env.err(
                `kodel: the config was refused (${plain(message)}); reading the place it names\n`,
              ),
          }),
    });
  };
  let placed: Promise<StoragePlace> | undefined;
  const storagePlace = (): Promise<StoragePlace> => {
    placed ??= resolvePlace(false);
    return placed;
  };

  /**
   * Whether this machine keeps the history of some project under `~/.kodel` (or `KODEL_STATE_DIR`):
   * the `projects` folder is there. Read from the command's own environment, not from the machine's.
   * For a project that is not in `home` mode it is the sign that the history of an earlier mode may
   * be in the other place (a branch without the keys was checked out, say).
   */
  const homeTreeInUse = async (): Promise<boolean> => {
    const given = env.environment?.["KODEL_STATE_DIR"] ?? "";
    const home = env.environment?.["HOME"] ?? env.environment?.["USERPROFILE"] ?? "";
    const base = given !== "" ? given : home !== "" ? join(home, ".kodel") : "";
    if (base === "" || !isAbsolute(base)) return false;
    return stat(join(base, "projects")).then(
      (info) => info.isDirectory(),
      () => false,
    );
  };
  const host = async () => {
    const { root, dataDir } = await project();
    return new LocalPipelineHost({ root, storeRoot: dataDir, storage: await storagePlace() });
  };
  const storeRoot = async () => (await project()).dataDir;

  /**
   * The folder of the history for a person at a terminal. An agent's shell has none, and the folder
   * (with the user's name in it) is not put into what an agent reads.
   */
  const shownPlace = (place: StoragePlace): string =>
    env.interactive
      ? plain(place.tree ?? place.lockRoot)
      : scrubHome(plain(place.tree ?? "."), place);

  async function openRun(host_: LocalPipelineHost, runId: string) {
    const run = await host_.open(runId);
    if (!run) {
      // The default project on a machine that keeps no history under `~/.kodel` keeps its text; the
      // hint is for a project that can have the history in the other place.
      const place = await storagePlace().catch(() => undefined);
      const hint =
        place?.mode === "home" || (await homeTreeInUse())
          ? "; if the storage setting in the config or KODEL_STATE_DIR is not what it was when the run was made, it may be kept in the other place"
          : "";
      throw new UserError(`there is no run "${runId}"${hint}`);
    }
    return run;
  }

  /** A decision on a run that another clone of the project made is allowed, and said. */
  async function warnIfForeign(run: Awaited<ReturnType<typeof openRun>>): Promise<void> {
    const root = await run.foreignRoot().catch(() => undefined);
    if (root !== undefined) {
      env.err(
        `kodel: run ${plain(run.runId)} was made by the checkout at ${plain(root)}, not this one; you are deciding on its behalf\n`,
      );
    }
  }

  /**
   * The decisions are a person's: no terminal, no decision. A command the engine runs (a test that
   * the agent wrote, say) is told so in its environment and is refused whatever its terminal is.
   * An agent that gets itself a pseudo-terminal passes the first check: that is a limit of what a
   * program run by the same user can tell, and the person's own terminal is what the rest rests on.
   */
  function requireHuman(): void {
    if (env.environment?.KODEL_ENGINE !== undefined) {
      throw new UserError(
        "this command is for a person; it will not run from a command the engine runs",
      );
    }
    if (!env.interactive) {
      throw new UserError(
        "this command is for a person at a terminal; it will not run from a script or an agent",
      );
    }
  }

  async function mustConfirm(question: string): Promise<void> {
    if (!(await env.confirm(question))) throw new UserError("not confirmed, nothing was changed");
  }

  /** A change of the run's pipeline that waits for the person, as one line; none when there is none. */
  async function pendingLine(
    run: Awaited<ReturnType<typeof openRun>>,
  ): Promise<string | undefined> {
    const found = await run.pendingChange().catch(() => undefined);
    if (!found) return undefined;
    const { info } = found;
    const where = info.watched === undefined ? "" : ` in ${plain(info.watched)}`;
    if (info.refused !== undefined) {
      return `a change of the pipeline${where} cannot be accepted: ${plain(info.refused)}`;
    }
    return `a change of the pipeline${where} waits for you: ${plain(info.apply)}`;
  }

  /** The decisions at a gate or a pause go after the pipeline change that is waiting, not before it. */
  async function refuseWhilePending(
    run: Awaited<ReturnType<typeof openRun>>,
    ignore: boolean | undefined,
  ): Promise<void> {
    if (ignore) return;
    const found = await run.pendingChange().catch(() => undefined);
    if (!found?.info.blocking) return;
    throw new UserError(
      `a change of the pipeline of run ${run.runId} is waiting for you: look at it and accept it with "${plain(found.info.apply)}", or put the pipeline file back as it was. To decide here without it: --ignore-pending-change`,
    );
  }

  /** Engine work started by a command runs in this process, so the command stays until it is done. */
  async function afterDecision(run: Awaited<ReturnType<typeof openRun>>) {
    await run.waitForRest(WORK_WAIT_MS);
    const state = await run.state();
    env.out(`${run.runId}: ${describeRun(state)}\n`);
  }

  program
    .command("mcp")
    .description("Serve the pipeline tools to a coding agent over stdio")
    .action(async () => {
      // A config that cannot be used for the tasks must not take the pipelines down with it: the
      // server starts without the task tools and says why on stderr (stdout is the protocol).
      let resolved: ProjectRoot;
      try {
        resolved = await project();
      } catch (error) {
        // Outside a project the server still starts: the agent gets the reason from every tool,
        // which is better than a server that is "not connected" and says nothing.
        if (error instanceof KodelError && error.code === "NO_PROJECT") {
          env.err(`kodel: ${plain(error.message)}\n`);
          await serveStdio(noProjectHost(error), pkg.version);
          return;
        }
        throw error;
      }
      let tasks: TaskService | undefined;
      let runLink: RunTaskLink | undefined;
      try {
        const opened = await openTaskService({ storeRoot: resolved.dataDir });
        tasks = opened?.service;
        runLink = opened?.runLink;
      } catch (error) {
        // Any failure (an unreadable config included) leaves the pipeline tools running.
        const why = error instanceof Error ? error.message : String(error);
        env.err(`kodel: the task tools are not served: ${plain(why)}\n`);
      }
      // The instructions are sent once, when the agent connects: a change of this setting applies
      // when the server is started again. A config that cannot be read leaves the default.
      const settings = await loadConfig(resolved.dataDir)
        .then((config) => ({
          waitHint: config.agent_hints.wait,
          dialog: config.decisions.dialog,
          agentDecisions: {
            gate: config.decisions.agent.gate,
            pipelineChange: config.decisions.agent.pipeline_change,
          },
        }))
        .catch(() => ({
          waitHint: true,
          dialog: false,
          agentDecisions: { gate: false, pipelineChange: false },
        }));
      const dialogTimeoutMs = dialogTimeoutFrom(env.environment);
      // The place the config names when the server starts. A config that names a place that cannot
      // be used (`home` without an id, a bad base) does not take the server down: the tools say why.
      let storage: StoragePlace | undefined;
      let storageError: KodelError | undefined;
      try {
        storage = await storagePlace();
      } catch (error) {
        // Whatever went wrong in finding the place (an unreadable config included) is carried to the
        // calls that need the history; the rest of the server is served.
        storageError =
          error instanceof KodelError
            ? error
            : new KodelError(
                "CONFIG_INVALID",
                `the place of the history cannot be found: ${error instanceof Error ? error.message : String(error)}`,
              );
        env.err(`kodel: ${plain(storageError.message)}\n`);
      }
      const local = new LocalPipelineHost({
        root: resolved.root,
        storeRoot: resolved.dataDir,
        ...(storage === undefined ? {} : { storage, watchStorage: () => resolvePlace(true) }),
        ...(storageError === undefined ? {} : { storageError }),
        agentDecisions: settings.agentDecisions,
        build: BUILD,
        // The same tie the tools were built for; without one the host asks the config itself.
        ...(runLink === undefined ? {} : { runTaskLink: runLink }),
      });
      await serveStdio(local, pkg.version, tasks, runLink, {
        waitHint: settings.waitHint,
        humans: local,
        dialog: settings.dialog,
        agentDecisions: settings.agentDecisions,
        ...(dialogTimeoutMs === undefined ? {} : { dialogTimeoutMs }),
      });
    });

  program
    .command("init")
    .description("Set the project up for your coding agents: MCP server, skills, config")
    .option(
      "--agent <list>",
      "agents to set up, comma-separated: claude-code, codex, opencode, all",
    )
    .option("-y, --yes", "ask nothing: use the flags and the agents found here")
    .option("--tasks", "turn the local task tracker on (asked when not given)")
    .option(
      "--storage <mode>",
      "where the history is kept: home (~/.kodel/projects/<id>, written into a new config) or project (.kodel, the default)",
    )
    .option("--server-command <command>", "how the agent starts the server", "kodel mcp")
    .option("--hooks", "register the hooks without asking (they are on by default)")
    .option("--no-hooks", "do not register the hooks that let Kodel see your agent sessions")
    .option("--force", "replace skills that were edited or that kodel did not write")
    .option("--dry-run", "show what would change without writing")
    .action(
      async (opts: {
        agent?: string;
        yes?: boolean;
        tasks?: true;
        storage?: string;
        serverCommand: string;
        hooks?: boolean;
        force?: boolean;
        dryRun?: boolean;
      }) => {
        if (opts.storage !== undefined && opts.storage !== "home" && opts.storage !== "project") {
          throw new UserError(`--storage is "home" or "project", not "${plain(opts.storage)}"`);
        }
        try {
          await runInit(
            {
              // init makes a project, so it never looks for one: the folder given, or this one.
              root: program.opts<{ root?: string }>().root ?? env.cwd,
              agents: opts.agent
                ?.split(",")
                .map((id) => id.trim())
                .filter(Boolean),
              yes: opts.yes ?? false,
              tasks: opts.tasks,
              ...(opts.storage === undefined ? {} : { storage: opts.storage }),
              serverCommand: opts.serverCommand,
              hooks: opts.hooks,
              force: opts.force ?? false,
              dryRun: opts.dryRun ?? false,
            },
            {
              out: env.out,
              interactive: env.interactive,
              select: env.select,
              confirm: env.confirm,
              environment: env.environment ?? {},
            },
          );
        } catch (error) {
          if (error instanceof InitError) throw new UserError(error.message);
          throw error;
        }
      },
    );

  program
    .command("hook <agent>")
    .description(
      "Called by a coding agent on its events (reads the event on stdin; always exits 0)",
    )
    .action(async (agent: string) => {
      // Never fails and prints nothing unless a handler means it: see `hooks/run.ts`.
      const input = env.readStdin ? await env.readStdin().catch(() => "") : "";
      const out = await runHook(agent, {
        text: input,
        tooLarge: Buffer.byteLength(input) > MAX_PAYLOAD_BYTES,
      });
      if (out !== "") env.out(out);
    });

  program
    .command("status [run]")
    .description("List the runs, or show one")
    .option("--json", "print the run list as JSON")
    .option("--no-headers", "do not print the header row of the run list")
    .action(async (runId: string | undefined, opts: { json?: boolean; headers?: boolean }) => {
      const place = await storagePlace();
      const h = await host();
      if (!runId) {
        const runs = await h.runSummaries();
        // Only in `home` mode the history may hold runs of another clone of the project, and runs
        // that have no recorded hash (moved here); the default mode prints what it always printed.
        const home = place.mode === "home";
        const foreign = new Map<string, string>();
        let unhashed = 0;
        if (home) {
          for (const { meta } of runs) {
            // Whose a run is needs only its record; whether it has a hash needs the run opened, which
            // only the table has a use for.
            const root = h.foreignRootOf(meta);
            if (root !== undefined) foreign.set(meta.runId, root);
            if (opts.json || opts.headers === false) continue;
            const opened = await h.open(meta.runId).catch(() => undefined);
            if ((await opened?.integrityStatus().catch(() => undefined)) === "unknown") unhashed++;
          }
        }
        if (opts.json) {
          const list = runs.map(({ meta, state }) => ({
            runId: meta.runId,
            pipeline: meta.pipeline,
            status: state?.status ?? "unreadable",
            slug: slugOf(meta, state),
            task: meta.task,
            ...(state?.workdir === undefined ? {} : { workdir: state.workdir }),
            ...(foreign.has(meta.runId) ? { foreign: foreign.get(meta.runId) } : {}),
          }));
          env.out(`${JSON.stringify(list, null, 2)}\n`);
          return;
        }
        // Notes before the table: a script that asks for no headers parses only the table.
        const notes = home && opts.headers !== false;
        if (notes) env.out(`storage: home (${shownPlace(place)})\n`);
        // A project that keeps its history in `.kodel` on a machine that keeps some under `~/.kodel`:
        // say which of the two this command reads, so a branch that dropped the keys is seen.
        if (!home && opts.headers !== false && !opts.json && (await homeTreeInUse())) {
          env.out(
            "storage: project (this project keeps its history in .kodel; history kept under ~/.kodel is not read)\n",
          );
        }
        if (notes && unhashed > 0) {
          env.out(
            `${unhashed} run${unhashed === 1 ? " has" : "s have"} no recorded hash here: ${unhashed === 1 ? "it is" : "they are"} trusted as found on first use\n`,
          );
        }
        if (runs.length === 0) env.out("no runs yet\n");
        const rows: string[][] = [];
        for (const { meta, state } of runs) {
          // Only a run that works somewhere other than the root says where.
          const where = state?.workdir === undefined ? "-" : plain(state.workdir);
          const open =
            state?.status === "running" || state?.status === "paused"
              ? await h.open(meta.runId).catch(() => undefined)
              : undefined;
          const pending = open && (await open.pendingChange().catch(() => undefined));
          const other = foreign.get(meta.runId);
          const note = `${pending ? "  [pipeline change waiting]" : ""}${other === undefined ? "" : `  [foreign: made by ${plain(other)}]`}`;
          rows.push([
            plain(meta.runId),
            plain(meta.pipeline),
            `${describeRun(state)}${note}`,
            where,
            plain(slugOf(meta, state)),
            plain(meta.task),
          ]);
        }
        const header = ["RUN", "PIPELINE", "STATUS", "WORKDIR", "SLUG", "TASK"];
        if (rows.length > 0) {
          for (const line of formatTable(header, rows, opts.headers !== false))
            env.out(`${line}\n`);
        }
        return;
      }
      const run = await openRun(h, runId);
      const state = await run.state();
      env.out(
        `run:       ${plain(state.runId)}\nslug:      ${plain(state.slug ?? runSlug(undefined, state.task))}\ntask:      ${plain(state.task)}\nstatus:    ${describeRun(state)}\n`,
      );
      // A state that is not as kodel left it is said below (integrity); the place is not guessed.
      const where = await run.location().catch(() => undefined);
      if (where) env.out(`workdir:   ${plain(where.path)}\n`);
      if (where?.branch) env.out(`branch:    ${plain(where.branch)}\n`);
      if (state.taskKey !== undefined) env.out(`tracker:   ${plain(state.taskKey)}\n`);
      const owner = await run.foreignRoot().catch(() => undefined);
      if (owner !== undefined) {
        env.out(
          `owner:     ${plain(owner)} (another checkout of this project; it is not continued here)\n`,
        );
      }
      env.out(`integrity: ${await run.integrityStatus()}\n`);
      env.out(`seal:      ${await run.sealStatus()}\n`);
      env.out(`trail:     ${state.trail.map(plain).join(" > ")}\n`);
      const pending = await pendingLine(run);
      if (pending) env.out(`pipeline:  ${pending}\n`);
      // A decision the agent made on the person's instruction is not one the person made: say so here.
      for (const made of (await run.report().catch(() => undefined))?.agent_decisions ?? []) {
        const what =
          made.what === "gate"
            ? `gate ${plain(made.node ?? "?")} ${plain(made.decision ?? "")}`
            : "change of the pipeline accepted";
        env.out(`by agent:  ${what} (told: "${plain(made.instruction).slice(0, 120)}")\n`);
      }
      // Read-only: looking at a run must not restart its work or write anything. A state that
      // cannot be read as a step (it names a node that is not there) is said to be unreadable
      // rather than ending the command, since this is the command one uses to find out what is wrong.
      try {
        const next = await run.inspect();
        if ("waiting" in next) {
          env.out(`waiting:   ${plain(next.waiting.node_slug)} (${next.waiting.reason})\n`);
        }
      } catch {
        env.out("next:      cannot be worked out from this state (it is not readable as a run)\n");
      }
    });

  program
    .command("wait <run>")
    .description(
      "Stay until a run stops waiting for a person, print one line, and exit; it changes nothing",
    )
    .option(
      "--timeout <seconds>",
      `give up after this long with nothing decided (0: never); exit code ${WAIT_GAVE_UP}`,
      String(WAIT_TIMEOUT_S),
    )
    .action(async (runId: string, opts: { timeout: string }) => {
      const limitS = wholeSeconds(opts.timeout);
      const run = await openRun(await host(), runId);
      const say = (what: string) => env.out(`${run.runId}: ${what}\n`);
      const lastSeq = async () =>
        (await run.journal()).reduce((last, r) => Math.max(last, r.seq), 0);
      // The journal first: a decision between the reads below is then still after `seen`.
      const seen = await lastSeq();
      const look = async () => {
        const step = await run.inspect();
        const state = await run.state();
        if (!("waiting" in step)) return { step, state, key: undefined };
        const { reason, behind, node_slug } = step.waiting;
        // Where it waits, so a new wait (a gate reached again after a rejection) counts as an end.
        const attempt = state.active.find((v) => v.phase === "human")?.attempt;
        return { step, state, key: [reason, behind, node_slug, attempt].join("|") };
      };
      const first = await look();
      if (!("waiting" in first.step)) {
        say(`not waiting for a person (${describeRun(first.state)}). Call pipeline_next_step.`);
        return;
      }
      const pollMs = env.pollMs ?? 1000;
      const pause = () => new Promise((resolve) => setTimeout(resolve, pollMs));
      env.onWatching?.();
      const started = Date.now();
      let now = first;
      while (now.key === first.key) {
        await pause();
        now = await look();
        if (now.key !== first.key) break;
        if (limitS > 0 && Date.now() - started >= limitS * 1000) {
          const where = first.step.waiting;
          say(
            `still waiting at "${plain(where.node_slug)}" (${where.reason}), nothing was decided in ${describeDuration(limitS)}. Not watching any more.`,
          );
          exitCode = WAIT_GAVE_UP;
          return;
        }
      }
      // What the person did is in the journal, and the journal is written just after the state, so
      // the record may come a moment after the change was seen. The first thing they did after we
      // began is the answer.
      const decisive = ["gate_decided", "run_resumed", "pipeline_accepted", "run_finished"];
      let done: Awaited<ReturnType<typeof run.journal>>[number] | undefined;
      for (let rounds = 0; !done && rounds <= Math.ceil(JOURNAL_GRACE_MS / pollMs); rounds++) {
        if (rounds > 0) await pause();
        done = (await run.journal()).find((r) => r.seq > seen && decisive.includes(r.event));
      }
      const node = plain(String(done?.node ?? ""));
      const where =
        "waiting" in now.step
          ? ` now waits at "${plain(now.step.waiting.node_slug)}" (${now.step.waiting.reason})`
          : ` is now ${describeRun(now.state)}`;
      const what =
        done?.event === "gate_decided"
          ? `${done.decision === "approved" ? "approved" : "rejected"} at "${node}"`
          : done?.event === "run_resumed"
            ? "resumed"
            : done?.event === "pipeline_accepted"
              ? "change accepted"
              : done?.event === "run_finished"
                ? `the run ended: ${plain(String(done.status))}`
                : `no decision, but the run${where}`;
      say(`${what}. Call pipeline_next_step.`);
    });

  program
    .command("gate <decision> <run>")
    .description("Approve or reject the human step a run is waiting at")
    .option("--node <slug>", "the step, if more than one is waiting")
    .option(
      "--reason <text>",
      "why (required when rejecting, unless comments were recorded at the step)",
    )
    .option(
      "--ignore-pending-change",
      "decide although a change of the pipeline is waiting for you",
    )
    .action(
      async (
        decision: string,
        runId: string,
        opts: { node?: string; reason?: string; ignorePendingChange?: boolean },
      ) => {
        requireHuman();
        if (decision !== "approve" && decision !== "reject") {
          throw new UserError(`the decision is "approve" or "reject", not "${decision}"`);
        }
        const run = await openRun(await host(), runId);
        await warnIfForeign(run);
        await refuseWhilePending(run, opts.ignorePendingChange);
        const state = await run.state();
        const waiting = state.active.filter((v) => v.phase === "human");
        const node = opts.node ?? waiting[0]?.node;
        if (!node || !waiting.some((v) => v.node === node)) {
          throw new UserError(
            `run ${runId} is not waiting for a decision${opts.node ? ` at "${plain(opts.node)}"` : ""}`,
          );
        }
        // What the agent did after the run stopped here is not what the checks saw. When that cannot
        // be told (the record is gone, or git fails: something an agent could make happen), it is
        // said so and approving needs one more yes. "Nothing changed" is only ever shown when the
        // engine really compared the files.
        const found = await run.changesSinceGate(node);
        // What the agent recorded as the person's comments goes back with a rejection, so it is
        // shown before the person confirms: the agent's wording, not necessarily theirs.
        const comments = decision === "reject" ? await run.gateResults(node) : undefined;
        if (decision === "reject" && !opts.reason && !comments) {
          throw new UserError('a rejection needs a reason: --reason "..."');
        }
        const question = [
          gateChangesText(found),
          comments ? gateCommentsText(comments) : undefined,
          `${decision === "approve" ? "Approve" : "Reject"} "${plain(node)}" of run ${plain(runId)}?`,
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n");
        await mustConfirm(question);
        if (found.kind === "unavailable" && decision === "approve") {
          await mustConfirm(
            "Approve although what changed since the run stopped here could not be checked?",
          );
        }
        failIfRefused(
          await run.decideHuman(
            node,
            decision === "approve" ? "approved" : "rejected",
            opts.reason,
          ),
        );
        await afterDecision(run);
      },
    );

  program
    .command("resume <run>")
    .description("Carry on a paused run, with more attempts for the step that stopped it")
    .option(
      "--ignore-pending-change",
      "resume although a change of the pipeline is waiting for you",
    )
    .action(async (runId: string, opts: { ignorePendingChange?: boolean }) => {
      requireHuman();
      const run = await openRun(await host(), runId);
      // Resuming continues the run, which only the checkout that made it does: said before asking.
      const owner = await run.foreignRoot().catch(() => undefined);
      if (owner !== undefined) {
        throw new UserError(
          `run ${plain(runId)} belongs to the checkout at ${plain(owner)}; it is resumed from there`,
        );
      }
      await refuseWhilePending(run, opts.ignorePendingChange);
      if ((await run.state()).status !== "paused") {
        throw new UserError(`run ${runId} is not paused`);
      }
      await mustConfirm(`Resume run ${runId} with more attempts?`);
      failIfRefused(await run.resume());
      await afterDecision(run);
    });

  program
    .command("ack <run>")
    .description("Accept the state of a run after you changed it by hand")
    .option("--note <text>", "what you changed")
    .action(async (runId: string, opts: { note?: string }) => {
      requireHuman();
      const run = await openRun(await host(), runId);
      await warnIfForeign(run);
      await mustConfirm(`Accept the state of run ${runId} as it is now?`);
      failIfRefused(await run.acknowledge(opts.note));
      env.out(`${runId}: accepted\n`);
    });

  const pipeline = withPlural(program.command("pipeline")).description(
    "Pipelines: a run's, and proposed ones",
  );
  const changes = pipeline
    .command("changes")
    .description(
      "Changes of the pipeline of a run: look at the one that waits, accept it, drop it, list the versions, put one back",
    );

  changes
    .command("show <run>", { isDefault: true })
    .description("The change that waits for you, if there is one")
    .action(async (runId: string) => {
      const run = await openRun(await host(), runId);
      await warnIfForeign(run);
      const found = await run.pendingChange();
      if (!found) {
        env.out(`${runId}: no change of the pipeline waits\n`);
        return;
      }
      env.out(`${await describePendingChange(run, found)}\n\n`);
      env.out(`To accept it: ${plain(found.info.apply)}\n`);
      env.out(`To drop it:   kodel pipeline changes discard ${runId}\n`);
    });

  changes
    .command("apply <run>")
    .description("Accept the change that waits: the run goes on with the new pipeline")
    .option("--reason <text>", "why, if the changes do not say it")
    .option("--from <source>", "which one to accept if there are two: proposal or file")
    .action(async (runId: string, opts: { reason?: string; from?: string }) => {
      requireHuman();
      if (opts.from !== undefined && opts.from !== "proposal" && opts.from !== "file") {
        throw new UserError('--from is "proposal" or "file"');
      }
      const run = await openRun(await host(), runId);
      await warnIfForeign(run);
      const state = await run.state();
      if (state.status !== "running" && state.status !== "paused") {
        throw new UserError(`run ${runId} is ${state.status}; its pipeline cannot change now`);
      }
      const found = await run.pendingChange(state, opts.from);
      if (!found) throw new UserError(`no change of the pipeline waits for run ${runId}`);
      if (found.info.refused !== undefined) {
        throw new UserError(`this change cannot be accepted: ${plain(found.info.refused)}`);
      }
      await mustConfirm(
        `${await describePendingChange(run, found)}\n\nAccept it for run ${plain(runId)}?`,
      );
      // What is accepted is what was shown: if the text moved while the person read, nothing is taken.
      const again = await run.pendingChange(undefined, found.info.source);
      if (!again || again.hash !== found.hash) {
        throw new UserError(
          `the change was modified while you were looking at it; nothing was accepted. Look at it again: kodel pipeline changes ${runId}`,
        );
      }
      failIfRefused(
        await run.acceptChange({
          source: found.info.source,
          text: found.text,
          ...(opts.reason === undefined ? {} : { reason: opts.reason }),
        }),
      );
      await afterDecision(run);
      if ((await run.state()).status === "paused") {
        env.out(`The run is still paused; carry it on with: kodel resume ${runId}\n`);
      }
    });

  changes
    .command("discard <run>")
    .description("Drop the agent's proposal, or put the pipeline file back as the run has it")
    .action(async (runId: string) => {
      requireHuman();
      const run = await openRun(await host(), runId);
      await warnIfForeign(run);
      const found = await run.pendingChange();
      if (!found) {
        env.out(`${runId}: no change of the pipeline waits\n`);
        return;
      }
      if (found.info.source === "proposal") {
        await mustConfirm(`Drop the agent's proposal for run ${plain(runId)}?`);
        await run.discardProposal();
        env.out(`${runId}: the proposal is dropped\n`);
        return;
      }
      await mustConfirm(
        `The change is in ${plain(found.info.watched ?? "the pipeline file")}. Put the file back as run ${plain(runId)} has it?`,
      );
      const restored = await run.restoreFile();
      env.out(`${runId}: ${plain(restored.path)} is back as it was\n`);
    });

  changes
    .command("history <run>")
    .description("The versions of the pipeline the run has had")
    .action(async (runId: string) => {
      const run = await openRun(await host(), runId);
      const { versions, orphans } = await run.history();
      for (const [i, v] of versions.entries()) {
        const when = new Date(v.at).toISOString().replace("T", " ").slice(0, 19);
        const how =
          v.how === "started"
            ? "started with"
            : `accepted (${v.how === "proposal" ? "the agent's proposal" : "a change in the file"})`;
        const steps = v.nodes.map((n) => `${plain(n.slug)} (${n.changes.map(plain).join(", ")})`);
        const effect = v.effect && v.effect !== "none" ? `  then: ${plain(v.effect)}` : "";
        env.out(
          `${i + 1}  ${plain(v.hash)}  ${when}  ${how}${v.current ? "  <- now" : ""}${
            steps.length > 0 ? `\n     changed: ${steps.join(", ")}${effect}` : ""
          }${v.reason ? `\n     reason: ${plain(v.reason)}` : ""}\n`,
        );
      }
      for (const hash of orphans) {
        env.out(`?  ${plain(hash)}  kept, but the history does not say it was accepted\n`);
      }
    });

  changes
    .command("restore <run> [hash]")
    .description(
      "Write a version the run has had into the pipeline file (the one it is on, by default)",
    )
    .action(async (runId: string, hash: string | undefined) => {
      requireHuman();
      const run = await openRun(await host(), runId);
      await warnIfForeign(run);
      const state = await run.state();
      await mustConfirm(
        `Write ${hash ? `version ${plain(hash)}` : "the version the run is on"} into ${plain(state.pipelineFile ?? "the pipeline file")}?`,
      );
      try {
        const restored = await run.restoreFile(hash);
        env.out(`${runId}: ${plain(restored.path)} is now version ${restored.hash}\n`);
      } catch (error) {
        if (error instanceof KodelError)
          throw new UserError(`${error.code}: ${plain(error.message)}`);
        throw error;
      }
    });

  const proposals = pipeline
    .command("proposals")
    .description(
      "Pipelines the agent proposed outside a run, new or changed: look at them, accept one, drop one",
    );

  /** A proposal as a person sees it; a record that is there but cannot be read says how to drop it. */
  async function missingOr(h: LocalPipelineHost, name: string) {
    const view = await h.pipelineProposal(name);
    if (view) return view;
    if (await h.hasPipelineProposal(name)) {
      throw new UserError(
        `the record of "${plain(name)}" is damaged or was written by another kodel; drop it: kodel pipeline proposals discard ${plain(name)}`,
      );
    }
    throw new UserError(`no proposal of a pipeline named "${plain(name)}" waits`);
  }

  proposals
    .command("show [name]", { isDefault: true })
    .description("The proposals that wait, or one in full")
    .action(async (name: string | undefined) => {
      const h = await host();
      if (name === undefined) {
        const waiting = await h.pipelineProposals();
        if (waiting.length === 0) env.out("no pipeline proposal waits\n");
        for (const r of waiting) {
          env.out(`${plain(r.name)}  ${r.kind}  ${plain(r.summary).slice(0, 100)}\n`);
        }
        return;
      }
      const view = await missingOr(h, name);
      env.out(`${formatProposal(view, plain)}\n\n`);
      if (view.refused !== undefined) {
        env.out(`It cannot be accepted: ${plain(view.refused)}\n`);
        return;
      }
      env.out(`To accept it: kodel pipeline proposals apply ${plain(name)}\n`);
      env.out(`To drop it:   kodel pipeline proposals discard ${plain(name)}\n`);
    });

  proposals
    .command("apply <name>")
    .description("Accept a proposal: the pipeline file is written")
    .action(async (name: string) => {
      requireHuman();
      const h = await host();
      const view = await missingOr(h, name);
      if (view.refused !== undefined) {
        throw new UserError(`this proposal cannot be accepted: ${plain(view.refused)}`);
      }
      await mustConfirm(
        `${formatProposal(view, plain)}\n\nWrite it to ${plain(view.path)}? Its commands will run on this machine.`,
      );
      // What is accepted is what was shown: if the text moved while the person read, nothing is taken.
      const done = await h.acceptPipelineProposal(name, view.hash);
      if (!done.ok) throw new UserError(plain(done.message));
      env.out(`${plain(done.path)} is written.\n`);
      env.out(
        "It is not committed: commit it when you are happy with it. A run that was started before and works in the repository will notice the change and wait for you.\n",
      );
    });

  proposals
    .command("discard <name>")
    .description("Drop a proposal")
    .action(async (name: string) => {
      requireHuman();
      const h = await host();
      // Whether it can be read does not matter here: a damaged record is dropped the same way.
      if (!(await h.hasPipelineProposal(name))) {
        env.out(`no proposal of a pipeline named "${plain(name)}" waits\n`);
        return;
      }
      await mustConfirm(`Drop the proposal of the pipeline "${plain(name)}"?`);
      await h.discardPipelineProposal(name);
      env.out(`the proposal of ${plain(name)} is dropped\n`);
    });

  program
    .command("report [run]")
    .description("Where the time went and what was redone in a run (the latest, if none is named)")
    .option("--json", "print the report as JSON")
    .action(async (runId: string | undefined, opts: { json?: boolean }) => {
      const h = await host();
      const id = runId ?? (await h.runSummaries()).at(-1)?.meta.runId;
      if (!id) throw new UserError("there are no runs yet");
      const run = await openRun(h, id);
      const report = await run.report();
      // The report is read from the run's own files, so it is only as good as they are: whether they
      // are as kodel last wrote them goes with it.
      const trust = { integrity: await run.integrityStatus(), seal: await run.sealStatus() };
      env.out(
        opts.json
          ? `${JSON.stringify({ ...report, ...trust }, null, 2)}\n`
          : formatReport(report, plain, trust),
      );
    });

  program
    .command("seal <run>")
    .description("Accept the files of a finished run after a deliberate change")
    .action(async (runId: string) => {
      requireHuman();
      const sealHost = await host();
      const sealed = await sealHost.open(runId).catch(() => undefined);
      if (sealed) await warnIfForeign(sealed);
      await mustConfirm(`Accept the files of finished run ${runId} as they are now?`);
      await sealHost.seal(runId).catch((error: unknown) => {
        if (error instanceof KodelError) throw error;
        throw new UserError(error instanceof Error ? error.message : String(error));
      });
      env.out(`${runId}: sealed\n`);
    });

  // ── feedback ────────────────────────────────────────────────────────────────
  // Goes to the Kodel inbox, not to the repository: it needs no run and no config.

  program
    .command("feedback [text]")
    .description("Send a bug report, an idea or a note to the Kodel developers")
    .option("--type <type>", "bug, feature or feedback", "feedback")
    .option("-m, --message <text>", 'the text (or pass it as the argument, or "-" for stdin)')
    .option(
      "-y, --yes",
      "send without asking (a person is asked first; a script or an agent must pass this)",
    )
    .option("--json", "print the answer as JSON")
    .addHelpText(
      "after",
      `
Examples:
  kodel feedback "gate refuses to run in tmux" --type bug
  echo "long description" | kodel feedback - --type feature --yes`,
    )
    .action(
      async (
        arg: string | undefined,
        opts: { type: string; message?: string; yes?: boolean; json?: boolean },
      ) => {
        if (!isFeedbackType(opts.type)) {
          throw new UserError(`--type is bug, feature or feedback, not "${plain(opts.type)}"`);
        }
        if (opts.message !== undefined && arg !== undefined) {
          throw new UserError("give the text as the argument or as --message, not both");
        }
        let text = opts.message ?? arg;
        if (text === "-") {
          // Both are a terminal only when a person typed the command, and then nothing is piped in.
          if (env.interactive)
            throw new UserError('"-" reads a pipe: echo "text" | kodel feedback -');
          text = await (env.readStdin?.() ?? Promise.resolve(""));
        }
        // The person or the agent may have pasted a log; what looks like a secret does not leave.
        text = text === undefined ? undefined : redactText(text.trim());
        if (!text) throw new UserError('a text is needed: kodel feedback "what went wrong"');
        if (text.length > FEEDBACK_MESSAGE_MAX) {
          throw new UserError(
            `the text is ${text.length} characters, the most is ${FEEDBACK_MESSAGE_MAX}`,
          );
        }
        const input = {
          type: opts.type,
          message: text,
          context: feedbackContext(pkg.version),
        };
        // What leaves the machine is shown before it leaves, and again to an agent that passes --yes;
        // with --json it goes to stderr so the answer on stdout stays one JSON document.
        (opts.json ? env.err : env.out)(`To ${FEEDBACK_ENDPOINT}:\n${safeJson(input)}\n`);
        if (!opts.yes) {
          if (!env.interactive) {
            throw new UserError("nothing was sent: no terminal to ask on, pass --yes to send it");
          }
          await mustConfirm("Send this?");
        }
        const id = await submitFeedback(env.fetch ?? fetch, input).catch((error: unknown) => {
          throw new UserError(error instanceof Error ? error.message : String(error));
        });
        // The id comes from the server, so it is cleaned like anything else shown to a person.
        env.out(opts.json ? `${safeJson({ id })}\n` : `sent: ${plain(id)}\n`);
      },
    );

  // ── tasks ───────────────────────────────────────────────────────────────────
  // The same service the MCP tools use, so a person and an agent get the same rules. Tasks carry no
  // trust decision, so (unlike `gate`) nothing here needs a terminal.

  async function tasksService(): Promise<TaskService> {
    let opened: Awaited<ReturnType<typeof openTaskService>>;
    try {
      opened = await openTaskService({ storeRoot: await storeRoot() });
    } catch (error) {
      if (error instanceof KodelError) {
        throw new UserError(`${error.code}: ${plain(error.message)}`);
      }
      throw error;
    }
    if (!opened) {
      throw new KodelError(
        "TASKS_DISABLED",
        "tasks are off: set tasks.enabled to true in .kodel/config.yaml (restart the MCP server to give the agent the tools)",
      );
    }
    return opened.service;
  }

  /** The answer of the service, or a refusal as an error of the command. */
  function answered(result: ToolResult): Record<string, unknown> {
    if (!result.ok) throw new UserError(formatFailure(result, plain));
    return result;
  }

  const collect = (value: string, previous: string[] = []) => [...previous, value];

  function fieldsOf(pairs: string[] | undefined): Record<string, string> | undefined {
    if (!pairs?.length) return undefined;
    const fields: Record<string, string> = {};
    for (const pair of pairs) {
      const at = pair.indexOf("=");
      if (at < 1) throw new UserError(`--field takes name=value, not "${plain(pair)}"`);
      fields[pair.slice(0, at)] = pair.slice(at + 1);
    }
    return fields;
  }

  const task = withPlural(program.command("task")).description(
    "The tasks of this repository (they are off until tasks.enabled is set in the config)",
  );

  task
    .command("add <title>")
    .description("Create a task")
    .option("--body <text>", "what the problem is")
    .option("--priority <name>", "a priority of the tracker (see: task schema)")
    .option("--type <name>", "a task type of the tracker")
    .option("--comment <text>", "a note to add")
    .option("--run <id>", "the pipeline run the task was found in")
    .option("--parent <key>", "make it a subtask of this task")
    .option("--field <name=value>", "a tracker field; repeat for more", collect)
    .action(async (title: string, opts: Record<string, string | string[] | undefined>) => {
      const service = await tasksService();
      const input: NewTask = { title };
      if (typeof opts.body === "string") input.body = opts.body;
      if (typeof opts.priority === "string") input.priority = opts.priority;
      if (typeof opts.type === "string") input.type = opts.type;
      if (typeof opts.comment === "string") input.comment = opts.comment;
      if (typeof opts.run === "string") input.run = opts.run;
      if (typeof opts.parent === "string") input.parent = opts.parent;
      const fields = fieldsOf(opts.field as string[] | undefined);
      if (fields) input.fields = fields;
      const made = answered(await service.create(input)).task as Task;
      env.out(`created ${plain(made.key)}: ${plain(made.title)}\n`);
    });

  task
    .command("list")
    .description("List the tasks; the unfinished ones unless --state says otherwise")
    .option("--state <states...>", "todo, progress, done (a list, or comma separated)")
    .option("--status <name>", "an exact status of the tracker")
    .option("--priority <name>", "a priority of the tracker")
    .option("--parent <key>", "only the subtasks of this task")
    .option("--top-level", "leave subtasks out")
    .option("--run <id>", "only tasks attached to this run")
    .option("--limit <n>", "how many (default 50, at most 200)", (v) => Number.parseInt(v, 10))
    .option("--cursor <text>", "the `next` of a previous page")
    .option("--json", "print the answer as JSON")
    .option("--no-headers", "do not print the header row")
    .action(async (opts: Record<string, unknown>) => {
      const service = await tasksService();
      const filter: Partial<TaskFilter> = {};
      if (Array.isArray(opts.state)) {
        filter.state = opts.state.flatMap((s: string) =>
          s.split(",").map((x) => x.trim()),
        ) as TaskFilter["state"];
      }
      if (typeof opts.status === "string") filter.status = opts.status;
      if (typeof opts.priority === "string") filter.priority = opts.priority;
      if (typeof opts.parent === "string") filter.parent = opts.parent;
      if (opts.topLevel === true) filter.top_level = true;
      if (typeof opts.run === "string") filter.run = opts.run;
      if (typeof opts.limit === "number") filter.limit = opts.limit;
      if (typeof opts.cursor === "string") filter.cursor = opts.cursor;
      const answer = answered(await service.list(filter));
      if (opts.json) {
        env.out(`${safeJson(answer)}\n`);
        return;
      }
      const tasks = answer.tasks as TaskSummary[];
      if (tasks.length === 0) env.out("no tasks\n");
      if (tasks.length > 0) {
        for (const line of formatTaskTable(tasks, plain, opts.headers !== false))
          env.out(`${line}\n`);
      }
      if (typeof answer.next === "string") {
        // A cursor belongs to the filter it came from, so the hint repeats the filter.
        const again = [
          ...(Array.isArray(opts.state) ? ["--state", opts.state.join(",")] : []),
          ...(typeof opts.status === "string" ? ["--status", opts.status] : []),
          ...(typeof opts.priority === "string" ? ["--priority", opts.priority] : []),
          ...(typeof opts.parent === "string" ? ["--parent", opts.parent] : []),
          ...(opts.topLevel === true ? ["--top-level"] : []),
          ...(typeof opts.run === "string" ? ["--run", opts.run] : []),
          ...(typeof opts.limit === "number" ? ["--limit", String(opts.limit)] : []),
          "--cursor",
          answer.next,
        ].map((a) => (/^[\w.,=-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`));
        env.out(`more: kodel task list ${again.join(" ")}\n`);
      }
      if (answer.truncated === true) env.out("the list may be incomplete\n");
      env.err(formatProblems(answer.problems as { message: string }[], plain));
    });

  task
    .command("show <key>")
    .description("Show a task in full")
    .option("--json", "print the answer as JSON")
    .action(async (key: string, opts: { json?: boolean }) => {
      const service = await tasksService();
      const answer = answered(await service.get({ key }));
      if (opts.json) {
        env.out(`${safeJson(answer)}\n`);
        return;
      }
      env.out(formatTask(answer.task as Task, answer.subtasks as SubtaskRef[], plain));
    });

  task
    .command("set <key>")
    .description("Change a task")
    .option("--status <name>", "the status to move it to")
    .option("--priority <name>", "a priority of the tracker")
    .option("--type <name>", "a task type of the tracker")
    .option("--title <text>", "a new title")
    .option("--body <text>", "a new text")
    .option("--comment <text>", "a note to add (it never replaces an earlier one)")
    .option("--add-run <id>", "attach a pipeline run")
    .option("--parent <key>", "move it under another task")
    .option(
      "--clear <name>",
      "empty a field: body, priority, type, parent or fields.<name>",
      collect,
    )
    .option("--field <name=value>", "a tracker field; repeat for more", collect)
    .action(async (key: string, opts: Record<string, string | string[] | undefined>) => {
      const service = await tasksService();
      const patch: TaskPatch = {};
      if (typeof opts.status === "string") patch.status = opts.status;
      if (typeof opts.priority === "string") patch.priority = opts.priority;
      if (typeof opts.type === "string") patch.type = opts.type;
      if (typeof opts.title === "string") patch.title = opts.title;
      if (typeof opts.body === "string") patch.body = opts.body;
      if (typeof opts.comment === "string") patch.comment = opts.comment;
      if (typeof opts.addRun === "string") patch.add_run = opts.addRun;
      if (typeof opts.parent === "string") patch.parent = opts.parent;
      if (Array.isArray(opts.clear)) patch.clear = opts.clear;
      const fields = fieldsOf(opts.field as string[] | undefined);
      if (fields) patch.fields = fields;
      const answer = answered(await service.update({ key, ...patch }));
      const changed = answer.task as Task;
      env.out(`updated ${plain(changed.key)}: ${plain(changed.status)}\n`);
      if (typeof answer.open_subtasks === "number") {
        env.out(`note: ${answer.open_subtasks} subtask(s) are still open\n`);
      }
    });

  task
    .command("schema [key]")
    .description("Show the statuses, priorities, types and fields of the tracker")
    .option("--type <name>", "the fields for creating this type")
    .option("--json", "print the answer as JSON")
    .action(async (key: string | undefined, opts: { type?: string; json?: boolean }) => {
      const service = await tasksService();
      const query: { key?: string; type?: string } = {};
      if (key !== undefined) query.key = key;
      if (opts.type !== undefined) query.type = opts.type;
      const answer = answered(await service.schema(query));
      env.out(
        opts.json
          ? `${safeJson(answer)}\n`
          : formatSchema(answer as unknown as Parameters<typeof formatSchema>[0], plain),
      );
    });

  task
    .command("doctor")
    .description("Check that the task adapter is set up and can be reached")
    .action(async () => {
      const service = await tasksService();
      const answer = answered(await service.verify());
      const problems = answer.problems as { message: string }[];
      env.out(`adapter: ${plain(String(answer.adapter))}\n`);
      if (problems.length === 0) {
        env.out("ok\n");
        return;
      }
      for (const p of problems) env.out(`problem: ${plain(p.message)}\n`);
      throw new UserError(`${problems.length} problem(s) found`);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof UserError || error instanceof KodelError) {
      env.err(`kodel: ${plain(error.message)}\n`);
      return 1;
    }
    throw error;
  }
}
