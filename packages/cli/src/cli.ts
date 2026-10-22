/**
 * The commands. The ones that decide something (`gate`, `resume`, `ack`, `seal`) are for a person
 * at a terminal and are deliberately not MCP tools: the agent cannot call them. They also refuse to
 * run without a terminal and ask for a confirmation, so an agent with shell access cannot simply
 * type them; the deny rules in the agent's settings are a second line, not the only one.
 */

import { join } from "node:path";
import { LocalPipelineHost, openTaskService } from "@kodel-ai/local";
import {
  type Decision,
  KodelError,
  type NewTask,
  type RunState,
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
import { formatChange, formatReport } from "./format";
import { serveStdio } from "./mcp-server";
import {
  formatFailure,
  formatProblems,
  formatSchema,
  formatTask,
  formatTaskLine,
} from "./task-format";

export interface CliEnv {
  cwd: string;
  out(text: string): void;
  err(text: string): void;
  /** Whether a person is at a terminal: stdin and stdout are both a TTY. */
  interactive: boolean;
  /** Ask the person a yes/no question. */
  confirm(question: string): Promise<boolean>;
  /** The environment the command runs in (`process.env`), looked at for the engine's marker. */
  environment?: Record<string, string | undefined>;
}

/** A problem to report to the user without a stack trace. */
class UserError extends Error {}

/** How long a command waits for engine work it started (a build, say) before it lets go. */
const WORK_WAIT_MS = 30 * 60_000;

const SHOWN_FILES = 10;

/**
 * Text that came from the agent (a task, a name, a file name) or from files it can write, with
 * what could mislead a person taking out: control characters (they move the cursor or fake a line),
 * the characters that reorder text (a file name can be made to read backwards), and line and
 * paragraph separators.
 */
const UNSAFE_CODES: [from: number, to: number][] = [
  [0x00, 0x1f], // control characters
  [0x7f, 0x9f], // delete and the C1 controls
  [0x61c, 0x61c], // Arabic letter mark
  [0x200e, 0x200f], // left-to-right and right-to-left marks
  [0x2028, 0x2029], // line and paragraph separators
  [0x202a, 0x202e], // embeddings and overrides
  [0x2066, 0x2069], // isolates
];

export function plain(text: string): string {
  let out = "";
  let skipped = false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (UNSAFE_CODES.some(([from, to]) => code >= from && code <= to)) {
      if (!skipped) out += " ";
      skipped = true;
    } else {
      out += char;
      skipped = false;
    }
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

function failIfRefused(decision: Decision): void {
  if (!decision.ok) {
    throw new UserError(`${decision.error.code}: ${plain(decision.error.message)}`);
  }
}

export async function runCli(argv: string[], env: CliEnv): Promise<number> {
  const program = new Command();
  program
    .name("kodel")
    .description("Spec-driven pipelines inside your coding agent")
    .version(pkg.version)
    .option("--root <dir>", "the repository the pipelines belong to", env.cwd)
    .exitOverride()
    .configureOutput({ writeOut: env.out, writeErr: env.err });

  const host = () => new LocalPipelineHost({ root: program.opts<{ root: string }>().root });
  const storeRoot = () => join(program.opts<{ root: string }>().root, ".kodel");

  async function openRun(host_: LocalPipelineHost, runId: string) {
    const run = await host_.open(runId);
    if (!run) throw new UserError(`there is no run "${runId}"`);
    return run;
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
      let tasks: TaskService | undefined;
      try {
        tasks = (await openTaskService({ storeRoot: storeRoot() }))?.service;
      } catch (error) {
        if (!(error instanceof KodelError)) throw error;
        env.err(`kodel: the task tools are not served: ${plain(error.message)}\n`);
      }
      await serveStdio(host(), pkg.version, tasks);
    });

  program
    .command("status [run]")
    .description("List the runs, or show one")
    .option("--json", "print the run list as JSON")
    .action(async (runId: string | undefined, opts: { json?: boolean }) => {
      const h = host();
      if (!runId) {
        const runs = await h.runSummaries();
        if (opts.json) {
          const list = runs.map(({ meta, state }) => ({
            runId: meta.runId,
            pipeline: meta.pipeline,
            status: state?.status ?? "unreadable",
            task: meta.task,
            ...(state?.workdir === undefined ? {} : { workdir: state.workdir }),
          }));
          env.out(`${JSON.stringify(list, null, 2)}\n`);
          return;
        }
        if (runs.length === 0) env.out("no runs yet\n");
        for (const { meta, state } of runs) {
          // Only a run that works somewhere other than the root says where.
          const where = state?.workdir === undefined ? "" : `  in ${plain(state.workdir)}`;
          const open =
            state?.status === "running" || state?.status === "paused"
              ? await h.open(meta.runId).catch(() => undefined)
              : undefined;
          const pending = open && (await open.pendingChange().catch(() => undefined));
          const note = pending ? "  [pipeline change waiting]" : "";
          env.out(
            `${plain(meta.runId)}  ${plain(meta.pipeline)}  ${describeRun(state)}${note}${where}  ${plain(meta.task)}\n`,
          );
        }
        return;
      }
      const run = await openRun(h, runId);
      const state = await run.state();
      env.out(
        `run:       ${plain(state.runId)}\ntask:      ${plain(state.task)}\nstatus:    ${describeRun(state)}\n`,
      );
      // A state that is not as kodel left it is said below (integrity); the place is not guessed.
      const where = await run.location().catch(() => undefined);
      if (where) env.out(`workdir:   ${plain(where.path)}\n`);
      if (where?.branch) env.out(`branch:    ${plain(where.branch)}\n`);
      env.out(`integrity: ${await run.integrityStatus()}\n`);
      env.out(`seal:      ${await run.sealStatus()}\n`);
      env.out(`trail:     ${state.trail.map(plain).join(" > ")}\n`);
      const pending = await pendingLine(run);
      if (pending) env.out(`pipeline:  ${pending}\n`);
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
        const run = await openRun(host(), runId);
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
        let question = `${decision === "approve" ? "Approve" : "Reject"} "${plain(node)}" of run ${plain(runId)}?`;
        if (comments) {
          const lines = comments.csv.split("\n").map((line) => `  ${plain(line)}`);
          question = `${comments.count} comment(s) recorded at this step will go back with the rejection:\n${lines.join("\n")}\n${question}`;
        }
        if (found.kind === "changes") {
          const files = Object.keys(found.files);
          if (files.length > 0) {
            const shown = files.slice(0, SHOWN_FILES).map((f) => `  ${plain(f)}`);
            const more =
              files.length > SHOWN_FILES ? [`  and ${files.length - SHOWN_FILES} more`] : [];
            question = `${files.length} file(s) changed since the run stopped here:\n${[...shown, ...more].join("\n")}\n${question}`;
          }
        } else if (found.kind === "unavailable") {
          question = `WARNING: the engine cannot tell what changed since the run stopped here: ${plain(found.reason)}\nThe agent may have gone on working after its checks passed.\n${question}`;
        }
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
      const run = await openRun(host(), runId);
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
      const run = await openRun(host(), runId);
      await mustConfirm(`Accept the state of run ${runId} as it is now?`);
      failIfRefused(await run.acknowledge(opts.note));
      env.out(`${runId}: accepted\n`);
    });

  const changes = program
    .command("pipeline")
    .description("The pipeline of a run")
    .command("changes")
    .description(
      "Changes of the pipeline of a run: look at the one that waits, accept it, drop it, list the versions, put one back",
    );

  /** What waits for the person, as the commands show it: where it came from, then the differences. */
  async function describePending(
    run: Awaited<ReturnType<typeof openRun>>,
    found: NonNullable<Awaited<ReturnType<typeof run.pendingChange>>>,
  ): Promise<string> {
    const { info } = found;
    const current = await run.currentSpec();
    const origin =
      info.source === "proposal"
        ? "The agent proposed another version of the pipeline."
        : `The pipeline file ${plain(info.watched ?? "")} was changed.`;
    const body = formatChange(current, found.spec, info.changes, info.redo, plain);
    return info.refused === undefined
      ? `${origin}\n\n${body}`
      : `${origin}\n\nIt cannot be accepted: ${plain(info.refused)}\n\n${body}`;
  }

  changes
    .command("show <run>", { isDefault: true })
    .description("The change that waits for you, if there is one")
    .action(async (runId: string) => {
      const run = await openRun(host(), runId);
      const found = await run.pendingChange();
      if (!found) {
        env.out(`${runId}: no change of the pipeline waits\n`);
        return;
      }
      env.out(`${await describePending(run, found)}\n\n`);
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
      const run = await openRun(host(), runId);
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
        `${await describePending(run, found)}\n\nAccept it for run ${plain(runId)}?`,
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
      const run = await openRun(host(), runId);
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
      const run = await openRun(host(), runId);
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
      const run = await openRun(host(), runId);
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

  program
    .command("report [run]")
    .description("Where the time went and what was redone in a run (the latest, if none is named)")
    .option("--json", "print the report as JSON")
    .action(async (runId: string | undefined, opts: { json?: boolean }) => {
      const h = host();
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
      await mustConfirm(`Accept the files of finished run ${runId} as they are now?`);
      await host()
        .seal(runId)
        .catch((error: unknown) => {
          if (error instanceof KodelError) throw error;
          throw new UserError(error instanceof Error ? error.message : String(error));
        });
      env.out(`${runId}: sealed\n`);
    });

  // ── tasks ───────────────────────────────────────────────────────────────────
  // The same service the MCP tools use, so a person and an agent get the same rules. Tasks carry no
  // trust decision, so (unlike `gate`) nothing here needs a terminal.

  async function tasksService(): Promise<TaskService> {
    let opened: Awaited<ReturnType<typeof openTaskService>>;
    try {
      opened = await openTaskService({ storeRoot: storeRoot() });
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

  const task = program
    .command("task")
    .description(
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
        env.out(`${JSON.stringify(answer, null, 2)}\n`);
        return;
      }
      const tasks = answer.tasks as TaskSummary[];
      if (tasks.length === 0) env.out("no tasks\n");
      for (const t of tasks) env.out(`${formatTaskLine(t, plain)}\n`);
      if (typeof answer.next === "string") {
        env.out(`more: kodel task list --cursor ${answer.next}\n`);
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
        env.out(`${JSON.stringify(answer, null, 2)}\n`);
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
          ? `${JSON.stringify(answer, null, 2)}\n`
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
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof UserError || error instanceof KodelError) {
      env.err(`kodel: ${plain(error.message)}\n`);
      return 1;
    }
    throw error;
  }
}
