/**
 * The commands. The ones that decide something (`gate`, `resume`, `ack`, `seal`) are for a person
 * at a terminal and are deliberately not MCP tools: the agent cannot call them. They also refuse to
 * run without a terminal and ask for a confirmation, so an agent with shell access cannot simply
 * type them; the deny rules in the agent's settings are a second line, not the only one.
 */

import { LocalPipelineHost } from "@kodel-ai/local";
import { type Decision, KodelError, type RunState } from "@kodel-ai/pipeline-core";
import { Command, CommanderError } from "commander";
import pkg from "../package.json" with { type: "json" };
import { formatReport } from "./format";
import { serveStdio } from "./mcp-server";

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
      await serveStdio(host(), pkg.version);
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
          env.out(
            `${plain(meta.runId)}  ${plain(meta.pipeline)}  ${describeRun(state)}${where}  ${plain(meta.task)}\n`,
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
    .option("--reason <text>", "why (required when rejecting)")
    .action(async (decision: string, runId: string, opts: { node?: string; reason?: string }) => {
      requireHuman();
      if (decision !== "approve" && decision !== "reject") {
        throw new UserError(`the decision is "approve" or "reject", not "${decision}"`);
      }
      if (decision === "reject" && !opts.reason) {
        throw new UserError('a rejection needs a reason: --reason "..."');
      }
      const run = await openRun(host(), runId);
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
      let question = `${decision === "approve" ? "Approve" : "Reject"} "${plain(node)}" of run ${plain(runId)}?`;
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
        await run.decideHuman(node, decision === "approve" ? "approved" : "rejected", opts.reason),
      );
      await afterDecision(run);
    });

  program
    .command("resume <run>")
    .description("Carry on a paused run, with more attempts for the step that stopped it")
    .action(async (runId: string) => {
      requireHuman();
      const run = await openRun(host(), runId);
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
