/**
 * `kodel agent start` (T-47, TASK-DSKQ): a person starts the coding agent in a terminal session of its own.
 *
 * - Plain: the profile's program with the person's prompt, in the project root. It is the person's own
 *   session and not a worker: no kodel server of ours, no permission flag, always a terminal.
 * - `--pipeline <name>`: kodel makes a run with no task and its worker through the one launcher, under
 *   the start lock, exactly as `s` in the TUI and `kodel serve` do.
 * - `--resume <id|name>`: a new terminal session continues the stored conversation of a finished one and
 *   keeps its name.
 *
 * The `engines` block is the person's: one that is not the committed one is shown and asked about here,
 * at their terminal, where a start nobody watches would be refused.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type EnginesAgainstHead, enginesQuestion, type WorkerSettings } from "@kodel-ai/local";
import {
  type Caller,
  foldSessionName,
  isSessionName,
  KodelError,
  type SessionAdapter,
  SessionError,
  type SessionListEntry,
  type StartResult,
} from "@kodel-ai/pipeline-core";
import {
  type AgentContext,
  type AgentProject,
  type AgentSessions,
  resumeProblem,
  type StartFlags,
} from "./agent-commands";
import { type AgentProfile, agentProfile } from "./agent-profiles";
import { terminalSizeOf } from "./attach-client";
import { shellQuote } from "./claude-worker";
import { plain } from "./plain";
import { probePty } from "./pty-loader";
import { launchRun } from "./tui/worker-start";
import { findOnPath, WORKER_PROFILE } from "./worker-launcher-session";

export interface AgentStartInput {
  ctx: AgentContext;
  sessions: AgentSessions;
  project: AgentProject;
  /** Connects this terminal to a session that was just started (`attachStarted` of the commands). */
  attachStarted(sessions: SessionAdapter, started: StartResult): Promise<void>;
}

/** How long a worker that is still `starting` is asked again whether a terminal can be connected to it. */
const ATTACH_TRIES = 30;
const ATTACH_RETRY_MS = 100;

/** How many characters of a prompt name its run to the agent. */
const TITLE_CHARS = 80;

const titleOf = (prompt: string): string => {
  const first = prompt.split("\n").find((line) => line.trim() !== "") ?? prompt;
  const chars = [...first.trim()];
  return chars.length > TITLE_CHARS
    ? `${chars.slice(0, TITLE_CHARS - 1).join("")}…`
    : chars.join("");
};

const profileOf = (ctx: AgentContext): AgentProfile => {
  const profile = agentProfile(WORKER_PROFILE);
  if (profile === undefined) ctx.fail(`there is no agent profile ${WORKER_PROFILE}`);
  return profile;
};

/**
 * The `engines` block for this start. One that is the committed one is used as it is; anything else is
 * shown (what differs, or why it cannot be told) and the person is asked once.
 */
async function acceptedEngines(
  ctx: AgentContext,
  project: AgentProject,
): Promise<EnginesAgainstHead["engines"]> {
  let found: EnginesAgainstHead;
  try {
    found = await project.engines();
  } catch (error) {
    ctx.fail(
      `the engines block cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const lines = enginesQuestion(found);
  if (lines.length > 0) {
    for (const line of lines) ctx.out(`${plain(line)}\n`);
    await ctx.mustConfirm("Start the agent with this engines block?");
  }
  return found.engines;
}

const settingsOf = (
  engines: EnginesAgainstHead["engines"],
  profile: AgentProfile,
): WorkerSettings | undefined =>
  Object.hasOwn(engines, profile.name) ? engines[profile.name] : undefined;

/** The session a person means by an id or a name: the one that runs, then the newest. */
function entryOf(all: readonly SessionListEntry[], ref: string): SessionListEntry | undefined {
  const byId = all.find((row) => row.id === ref);
  if (byId) return byId;
  if (!isSessionName(ref)) return undefined;
  const wanted = foldSessionName(ref);
  const named = all.filter((row) => row.name === wanted).sort((a, b) => (a.id < b.id ? 1 : -1));
  return named.find((row) => row.status.state === "running") ?? named[0];
}

/** What only one of the three forms takes: each refusal names the flag, and nothing is started. */
function checkFlags(ctx: AgentContext, flags: StartFlags, prompt: string): void {
  if (flags.name !== undefined && !isSessionName(flags.name)) ctx.fail("the name is not valid");
  if (flags.resume !== undefined) {
    if (prompt !== "") {
      ctx.fail(
        "--resume takes no prompt: the agent continues its conversation, and you type in its terminal",
      );
    }
    if (flags.pipeline !== undefined) {
      ctx.fail(
        "--resume takes no --pipeline: the agent of a run is resumed by the TUI or kodel serve",
      );
    }
    if (flags.name !== undefined) ctx.fail("--resume takes no --name: the agent keeps its name");
    return;
  }
  if (flags.pipeline !== undefined) {
    if (flags.name !== undefined) {
      ctx.fail("--pipeline takes no --name: the agent of a run is named after the run (kw-<run>)");
    }
    if (prompt === "") ctx.fail("--pipeline needs a prompt: it is the text of the run's task");
  }
}

export async function runAgentStart(
  input: AgentStartInput,
  flags: StartFlags,
  words: readonly string[],
): Promise<void> {
  const prompt = words.join(" ").trim();
  checkFlags(input.ctx, flags, prompt);
  if (flags.pipeline !== undefined) return startForPipeline(input, flags.pipeline, prompt, flags);
  return startOwn(input, flags, prompt);
}

/** A person's own session: the plain start, and the resume of a finished one. */
async function startOwn(input: AgentStartInput, flags: StartFlags, prompt: string): Promise<void> {
  const ctx: AgentContext = input.ctx;
  const { sessions, project } = input;
  const profile = profileOf(ctx);
  const environment = ctx.environment;

  // The session to continue is judged before anything is asked or started.
  let old: SessionListEntry | undefined;
  if (flags.resume !== undefined) {
    const found = entryOf(await sessions.list(), flags.resume);
    if (found === undefined) {
      throw new SessionError("NOT_FOUND", `no agent ${JSON.stringify(flags.resume)}`);
    }
    const refused = resumeProblem(found);
    if (refused !== undefined) ctx.fail(`not resumed: ${refused}`);
    old = found;
  }

  const usable = (ctx.ptyProbe ?? probePty)();
  if (!usable.ok) ctx.fail(usable.reason);

  const settings = settingsOf(await acceptedEngines(ctx, project), profile);
  const command = settings?.terminal?.command;
  const program = command?.[0] ?? profile.program;
  const which = ctx.which ?? ((name: string) => findOnPath(name, environment));
  if (!program.includes("/") && (await which(program)) === undefined) {
    ctx.fail(`${program} was not found on PATH`);
  }

  const conversation = old?.agent?.session;
  const sessionId = conversation ?? (ctx.uuid ?? randomUUID)();
  const argv = profile.sessionArgv({
    ...(old === undefined ? { sessionId } : { resume: sessionId }),
    ...(old !== undefined || prompt === "" ? {} : { prompt }),
    ...(command === undefined ? {} : { command }),
  });

  ctx.out(`starts: ${plain(argv.map(shellQuote).join(" "))}\n`);
  const config = await project.config().catch(() => undefined);
  const readText =
    ctx.readText ?? ((path: string) => readFile(path, "utf8").catch(() => undefined));
  const trust = await profile.trustProbe(project.root, environment, readText);
  const name = old?.name ?? flags.name;
  ctx.out(
    `this is your own agent, with its own defaults: left alone (--bg, or after Ctrl+\\) it waits at its own questions${
      trust === "will_ask" ? `, the first one whether ${plain(project.root)} is trusted` : ""
    } until you attach\n`,
  );
  if (config?.dialog === true) {
    ctx.out("decisions.dialog is on: this agent's dialogs show in its own terminal\n");
  }
  // 5M9D: every child of a session carries the engine's mark, and under it `kodel mcp` with no role is a
  // worker. The person is told before the agent starts, not left to find the tools missing.
  const decides = config?.agentDecides ?? [];
  ctx.out(
    `a kodel server this agent starts for itself is a worker inside a kodel session: it works runs, has no history and no manager tools, and decides nothing${
      decides.length > 0 ? `, whatever decisions.agent (${decides.join(", ")}) says` : ""
    }; one set to --role manager or --read-only does not start there\n`,
  );
  const stateDir = environment.KODEL_STATE_DIR;
  if (stateDir !== undefined && stateDir !== "") {
    ctx.out(
      `warning: KODEL_STATE_DIR is set in your shell (${plain(stateDir)}); an agent's session does not get it, so the kodel server this agent starts for itself keeps its state in the default place\n`,
    );
  }

  const size = (ctx.terminalSize ?? (() => terminalSizeOf(process.stdout)))();
  const started = await sessions.start(
    {
      argv,
      cwd: project.root,
      origin: "cli",
      mode: "pty",
      // As a worker gets it: without the marks of a Claude Code session this command may be run from,
      // which would make the agent stop saving its conversation (and `--resume` would find none).
      inheritEnv: false,
      env: profile.env(environment),
      ...(size ? { size } : {}),
      ...(name === undefined ? {} : { name }),
      // The id is chosen here and written down by the starter: nothing the agent prints is read for it.
      agent: {
        engine: profile.name,
        session: sessionId,
        ...(old === undefined ? {} : { resumes: old.id }),
      },
    },
    old === undefined ? {} : { takeName: old.id },
  );
  const ref = started.name ?? started.id;
  ctx.out(
    `${old === undefined ? "started" : `resumed ${plain(old.id)} as`} ${plain(started.id)}${started.name ? ` (${plain(started.name)})` : ""}\n`,
  );
  if (flags.bg) {
    ctx.out(`attach with: kodel agent attach ${plain(ref)}\n`);
    return;
  }
  await input.attachStarted(sessions, started);
}

/** `--pipeline`: a run with no task and its worker, through the launcher every starter uses. */
async function startForPipeline(
  input: AgentStartInput,
  pipeline: string,
  prompt: string,
  flags: StartFlags,
): Promise<void> {
  const ctx: AgentContext = input.ctx;
  const { sessions, project } = input;
  let config: Awaited<ReturnType<AgentProject["config"]>>;
  try {
    config = await project.config();
  } catch (error) {
    ctx.fail(error instanceof Error ? error.message : String(error));
  }
  const host = await project.host();
  const pipelines = (await host.list()).pipelines.map((p) => p.name);
  if (!pipelines.includes(pipeline)) {
    ctx.fail(
      `there is no pipeline "${plain(pipeline)}"${pipelines.length > 0 ? ` (there are: ${pipelines.map(plain).join(", ")})` : ""}`,
    );
  }
  // The block a person saw and accepted is the block of this start, in the preflight and in the launch.
  const engines = await acceptedEngines(ctx, project);
  const launcher = await project.launcher(async () => ({ ok: true, engines }));
  const check = await launcher.preflight({
    dialog: config.dialog,
    taskLink: false,
    noTask: true,
    pipelines: pipelines.length,
    worktreesDir: config.worktreesDir,
  });
  if (!check.ok) ctx.fail(`cannot start: ${check.reason}`);
  if (check.note !== undefined) ctx.out(`${plain(check.note)}\n`);

  const caller: Caller = { name: "kodel-agent-start", version: project.version };
  const launch = () =>
    launchRun({
      host,
      launcher,
      root: project.root,
      caller,
      pipeline,
      task: prompt,
      title: titleOf(prompt),
      subject: `a run of ${pipeline}`,
    });
  let result: Awaited<ReturnType<typeof launchRun>>;
  try {
    result =
      host.withWorkerStartLock === undefined
        ? await launch()
        : await host.withWorkerStartLock(launch);
  } catch (error) {
    if (error instanceof KodelError && error.code === "STATE_LOCKED") {
      ctx.fail("another start is in progress, try again");
    }
    throw error;
  }
  if (!result.ok || result.runId === undefined) ctx.fail(result.message);
  ctx.out(`${plain(result.message)}\n`);
  const name = result.agent ?? `kw-${result.runId}`;
  let open = await launcher.attachable(result.runId);
  // A holder that still opens its terminal reads `starting` and cannot be reached yet: asked again for a moment.
  for (let i = 0; !open.ok && i < ATTACH_TRIES; i++) {
    const status = (await launcher.statuses([result.runId])).get(result.runId);
    if (status?.state !== "starting") break;
    await new Promise((resolve) => setTimeout(resolve, ATTACH_RETRY_MS));
    open = await launcher.attachable(result.runId);
  }
  if (!open.ok) {
    // A print worker has no terminal; nothing is attached and the reason says where its output is.
    ctx.out(`not attached: ${plain(open.reason)}\n`);
    return;
  }
  if (flags.bg) {
    ctx.out(`attach with: kodel agent attach ${plain(name)}\n`);
    return;
  }
  await input.attachStarted(sessions, { id: open.id, name });
}
