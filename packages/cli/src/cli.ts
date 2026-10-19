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
import { serveStdio } from "./mcp-server";

export interface CliEnv {
  cwd: string;
  out(text: string): void;
  err(text: string): void;
  /** Whether a person is at a terminal: stdin and stdout are both a TTY. */
  interactive: boolean;
  /** Ask the person a yes/no question. */
  confirm(question: string): Promise<boolean>;
}

/** A problem to report to the user without a stack trace. */
class UserError extends Error {}

/** How long a command waits for engine work it started (a build, say) before it lets go. */
const WORK_WAIT_MS = 30 * 60_000;

const SHOWN_FILES = 10;

/** Text that came from the agent (a task, a name) with control characters taken out, so it cannot move the cursor or fake a line. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const plain = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");

function describeRun(state: RunState | undefined): string {
  if (!state) return "unreadable";
  if (state.status === "paused")
    return `paused (${plain(state.pause?.reason ?? "?")} at ${plain(state.pause?.node ?? "?")})`;
  const at = state.active.map((v) => `${plain(v.node)}#${v.attempt}`).join(", ");
  return at ? `${state.status} at ${at}` : state.status;
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

  /** The decisions are a person's: no terminal, no decision. */
  function requireHuman(): void {
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
    .action(async (runId?: string) => {
      const h = host();
      if (!runId) {
        const runs = await h.runSummaries();
        if (runs.length === 0) env.out("no runs yet\n");
        for (const { meta, state } of runs) {
          env.out(
            `${meta.runId}  ${plain(meta.pipeline)}  ${describeRun(state)}  ${plain(meta.task)}\n`,
          );
        }
        return;
      }
      const run = await openRun(h, runId);
      const state = await run.state();
      env.out(
        `run:       ${state.runId}\ntask:      ${plain(state.task)}\nstatus:    ${describeRun(state)}\n`,
      );
      env.out(`integrity: ${await run.integrityStatus()}\n`);
      env.out(`seal:      ${await run.sealStatus()}\n`);
      env.out(`trail:     ${state.trail.map(plain).join(" > ")}\n`);
      // Read-only: looking at a run must not restart its work or write anything.
      const next = await run.inspect();
      if ("waiting" in next) {
        env.out(`waiting:   ${plain(next.waiting.node_slug)} (${next.waiting.reason})\n`);
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
      // What the agent did after the run stopped here is not what the checks saw.
      const changes = await run.changesSinceGate(node);
      const files = Object.keys(changes ?? {});
      let question = `${decision === "approve" ? "Approve" : "Reject"} "${plain(node)}" of run ${runId}?`;
      if (files.length > 0) {
        const shown = files.slice(0, SHOWN_FILES).map((f) => `  ${plain(f)}`);
        const more = files.length > SHOWN_FILES ? [`  and ${files.length - SHOWN_FILES} more`] : [];
        question = `${files.length} file(s) changed since the run stopped here:\n${[...shown, ...more].join("\n")}\n${question}`;
      }
      await mustConfirm(question);
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
      env.err(`kodel: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
