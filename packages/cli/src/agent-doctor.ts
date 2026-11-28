/**
 * `kodel agent doctor` (T-47): whether a background agent can start here, and why not. Seven checks: the
 * platform; can a terminal run; the agent's program (found, its version, signed in; a program the
 * `engines` block names is run only when the block is the committed one); trust of the folder
 * the worktrees are made in; `decisions.dialog` and `decisions.agent`; the `engines` block against the
 * committed one; and the verdict, which is the launcher's own preflight.
 *
 * It only reads, so an agent may run it. It prints kodel's own words and never what a probe printed: the
 * sign-in probe names an account.
 *
 * One line a check: a mark (`✓` holds, `✗` does not, `?` cannot be told), the check, and what was found,
 * dimmed. Under every `✗` and `?` an indented line says what to do about it. The verdict stands apart at
 * the end. Colour only when the output is a terminal and `NO_COLOR` is not set; the marks say the same
 * without it.
 */
import { readFile } from "node:fs/promises";
import { type EnginesAgainstHead, enginesQuestion } from "@kodel-ai/local";
import type { AgentContext, AgentProject } from "./agent-commands";
import { agentProfile, workerMechanismOf, workerProgramOf } from "./agent-profiles";
import { plain } from "./plain";
import { probePty } from "./pty-loader";
import type { PreflightResult } from "./worker-launcher";
import { execChild, findOnPath, WORKER_PROFILE } from "./worker-launcher-session";

export interface AgentDoctorInput {
  ctx: AgentContext;
  project: AgentProject;
}

type Answer = "yes" | "no" | "unknown";

/** One line of the report, with what to do about it when it does not hold. */
interface Check {
  check: string;
  answer: Answer;
  /** What was found: a path, a version, the reason. */
  value?: string;
  /** What to do; printed for `no` and `unknown` only. */
  fix?: string;
  /** Lines that belong under the check (what differs in the `engines` block). */
  more?: string[];
}

export const DOCTOR_MARKS: Record<Answer, string> = { yes: "✓", no: "✗", unknown: "?" };
const MARK_COLOUR: Record<Answer, string> = { yes: "32", no: "31", unknown: "33" };
const LABEL_WIDTH = 28;

const VERSION = /\b\d+\.\d+\.\d+\b/;
const VERSION_TIMEOUT_MS = 10_000;
const CONFIG = ".kodel/config.yaml";

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Whether the report is coloured: the output is a terminal and `NO_COLOR` is not set. */
export const doctorColour = (ctx: Pick<AgentContext, "outIsTerminal" | "environment">): boolean =>
  ctx.outIsTerminal === true && (ctx.environment.NO_COLOR ?? "") === "";

/** The lines of one check. */
export function doctorLines(row: Check, colour: boolean, indent = "  "): string[] {
  const paint = (code: string, text: string) => (colour ? `\x1b[${code}m${text}\x1b[0m` : text);
  const mark = paint(MARK_COLOUR[row.answer], DOCTOR_MARKS[row.answer]);
  const value = row.value === undefined ? "" : plain(row.value);
  const head =
    value === ""
      ? `${indent}${mark} ${row.check}`
      : `${indent}${mark} ${row.check.padEnd(LABEL_WIDTH)}  ${paint("2", value)}`;
  const lines = [head];
  for (const line of row.more ?? []) {
    lines.push(`${indent}    ${paint("2", plain(line.trimStart()))}`);
  }
  if (row.answer !== "yes" && row.fix !== undefined) {
    lines.push(`${indent}    → ${plain(row.fix)}`);
  }
  return lines;
}

/** Prints the checks; answers whether a worker can start (the command exits 1 only when it cannot). */
export async function runAgentDoctor(input: AgentDoctorInput): Promise<boolean> {
  const ctx: AgentContext = input.ctx;
  const { project } = input;
  const environment = ctx.environment;
  const colour = doctorColour(ctx);
  const say = (row: Check, indent?: string) => {
    for (const line of doctorLines(row, colour, indent)) ctx.out(`${line}\n`);
  };
  const profile = agentProfile(WORKER_PROFILE);
  if (profile === undefined) ctx.fail(`there is no agent profile ${WORKER_PROFILE}`);

  // 1. The platform.
  const platform = ctx.platform ?? process.platform;
  say({
    check: "platform supported",
    answer: platform === "win32" ? "no" : "yes",
    value: platform,
    fix: "agents run on macOS and Linux: use one of them (WSL on Windows)",
  });

  // The block of check 6 is read first: the program of check 3 comes from it.
  const found: EnginesAgainstHead = await project
    .engines()
    .catch((error: unknown) => ({ state: "failed", engines: {}, reason: reasonOf(error) }));
  const settings = Object.hasOwn(found.engines, profile.name)
    ? found.engines[profile.name]
    : undefined;
  const mechanism = workerMechanismOf(settings);
  const program = workerProgramOf(profile, settings, mechanism);

  // 2. Can a terminal run.
  const pty = (ctx.ptyProbe ?? probePty)();
  say({
    check: "a terminal session can run",
    answer: pty.ok ? "yes" : "no",
    ...(pty.ok ? {} : { value: pty.reason }),
    fix: `run the installed kodel on Node (reinstall it if its terminal module is missing), or commit engines.${profile.name}.worker: print in ${CONFIG}`,
  });

  // 3. The program: found, its version, signed in.
  const which = ctx.which ?? ((name: string) => findOnPath(name, environment));
  const exec = ctx.exec ?? execChild;
  const at = program.includes("/") ? program : await which(program);
  const own = program === profile.program;
  say({
    check: `${profile.name} found`,
    answer: at === undefined ? "no" : "yes",
    value: at ?? `${program} is not on PATH`,
    fix: own
      ? `install ${profile.program} and make sure it is on PATH`
      : `put ${program} on PATH, or change engines.${profile.name}.terminal.command in ${CONFIG}`,
  });
  const signedIn = (auth: Awaited<ReturnType<typeof profile.authProbe>> | undefined): Check => ({
    check: `${profile.name} signed in`,
    answer: auth === undefined || !auth.known ? "unknown" : auth.loggedIn ? "yes" : "no",
    fix:
      auth?.known === true
        ? `run ${profile.program} auth login`
        : `${profile.program} did not say: run ${profile.program} auth status, and ${profile.program} auth login if it is signed out`,
  });
  // A worker's shell can write the config, and a person runs this command: a program the block names is
  // run only when the block is the committed one. The profile's own program is not the block's choice.
  if (at !== undefined && !own && found.state !== "committed") {
    say({
      check: `${profile.name} version`,
      answer: "unknown",
      value: `${program} is not run: engines.${profile.name}.terminal.command is not as committed`,
      fix: `commit ${CONFIG} or put its engines block back, then run kodel agent doctor again`,
    });
    // The sign-in probe is the profile's own program, never the block's.
    say(
      signedIn(
        (await which(profile.program)) === undefined
          ? undefined
          : await profile.authProbe(exec, ctx.now ?? Date.now),
      ),
    );
  } else if (at !== undefined) {
    const printed = await exec(program, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS }).then(
      (result) => VERSION.exec(result.stdout)?.[0],
      () => undefined,
    );
    say({
      check: `${profile.name} version`,
      answer: printed === undefined ? "unknown" : "yes",
      ...(printed === undefined ? {} : { value: printed }),
      fix: `${program} --version printed no version: run it yourself and see what it says`,
    });
    say(signedIn(await profile.authProbe(exec, ctx.now ?? Date.now)));
  }

  // 4. Trust of the folder the worktrees are made in.
  const config = await project.config().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, reason: reasonOf(error) }),
  );
  const fixConfig = `make ${CONFIG} readable (the reason is above), then run kodel agent doctor again`;
  const readText =
    ctx.readText ?? ((path: string) => readFile(path, "utf8").catch(() => undefined));
  if (config.ok) {
    const dir = config.value.worktreesDir;
    const trust = await profile.trustProbe(dir, environment, readText);
    say({
      check: "worktrees folder trusted",
      answer: trust === "trusted" ? "yes" : trust === "will_ask" ? "no" : "unknown",
      value: dir,
      fix:
        trust === "will_ask"
          ? `start ${profile.program} in the project root once and accept; kodel never accepts it for you`
          : `${profile.program}'s own file does not say: if ${profile.program} asks whether it trusts the folder, start it in the project root once and accept`,
    });
  } else {
    say({
      check: "worktrees folder trusted",
      answer: "unknown",
      value: "the config cannot be read",
      fix: fixConfig,
    });
  }

  // 5. The decisions block.
  if (config.ok) {
    const decides = config.value.agentDecides;
    say({
      check: "decisions.dialog off",
      answer: config.value.dialog ? "no" : "yes",
      ...(config.value.dialog
        ? { value: "a background agent cannot answer a dialog: no worker starts" }
        : {}),
      fix: `set decisions.dialog: false in ${CONFIG} (that block is yours to change, not an agent's)`,
    });
    say({
      check: "decisions.agent off",
      answer: decides.length === 0 ? "yes" : "no",
      ...(decides.length === 0
        ? {}
        : {
            value: `${decides.join(", ")}: a worker's own server never decides, and inside a session of kodel agent start the project's server is a worker too${
              decides.some((key) => key === "start_task" || key === "stop_agent")
                ? "; start_task and stop_agent give a manager server tools that start a task without `kodel task approve` and stop a run's agent, and a worker never gets them"
                : ""
            }`,
          }),
      fix: `nothing stops a worker; the block lets an agent started outside kodel decide: to let no agent decide, take decisions.agent out of ${CONFIG}`,
    });
  } else {
    say({ check: "decisions.dialog off", answer: "unknown", value: config.reason, fix: fixConfig });
    say({ check: "decisions.agent off", answer: "unknown", fix: fixConfig });
  }

  // 6. The engines block against the committed one.
  say({
    check: "engines block as committed",
    answer: found.state === "committed" ? "yes" : found.state === "differs" ? "no" : "unknown",
    value:
      found.state === "committed"
        ? `worker: ${mechanism}`
        : found.state === "failed"
          ? found.reason
          : found.state === "untracked"
            ? `git does not track ${CONFIG}; worker: ${mechanism}`
            : "kodel serve and the TUI start no agent until it is committed or put back",
    more: enginesQuestion(found).slice(1),
    fix:
      found.state === "differs"
        ? `commit ${CONFIG} if the change is yours, or put the engines block back (git diff ${CONFIG})`
        : found.state === "untracked"
          ? `commit ${CONFIG}: a change of its engines block is then seen before an agent starts`
          : `let git read the committed ${CONFIG} here (the reason is above)`,
  });

  // 7. The verdict: the launcher's own preflight, for a start by a person and for one nobody watches.
  const verdict = async (unattended: boolean): Promise<PreflightResult> => {
    if (!config.ok) return { ok: false, reason: config.reason };
    try {
      const launcher = await project.launcher();
      const pipelines = (await (await project.host()).list()).pipelines.length;
      return await launcher.preflight({
        dialog: config.value.dialog,
        taskLink: false,
        noTask: true,
        pipelines,
        worktreesDir: config.value.worktreesDir,
        ...(unattended ? { unattended: true } : {}),
      });
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
  };
  const person = await verdict(false);
  // Set apart from the checks: an empty line, and no indent.
  ctx.out("\n");
  say(
    {
      check: person.ok ? "a worker can start" : "a worker cannot start",
      answer: person.ok ? "yes" : "no",
      ...(person.ok ? {} : { value: person.reason }),
      fix: "see the lines marked ✗ and ? above, then run kodel agent doctor again",
    },
    "",
  );
  if (person.ok) {
    const daemon = await verdict(true);
    if (!daemon.ok) {
      say(
        {
          check: "kodel serve cannot start one",
          answer: "no",
          value: daemon.reason,
          fix: "kodel agent start and s in the TUI still can; see the lines marked ✗ and ? above",
        },
        "",
      );
    }
  }
  return person.ok;
}
