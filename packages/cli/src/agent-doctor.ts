/**
 * `kodel agent doctor` (T-45): whether a background agent can start here, and why not. Seven checks: the
 * platform; can a terminal run; the agent's program (found, its version, signed in); trust of the folder
 * the worktrees are made in; `decisions.dialog` and `decisions.agent`; the `engines` block against the
 * committed one; and the verdict, which is the launcher's own preflight.
 *
 * It only reads, so an agent may run it. It prints kodel's own words (yes, no, unknown and a reason) and
 * never what a probe printed: the sign-in probe names an account.
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

const VERSION = /\b\d+\.\d+\.\d+\b/;
const VERSION_TIMEOUT_MS = 10_000;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Prints the checks; answers whether a worker can start (the command exits 1 only when it cannot). */
export async function runAgentDoctor(input: AgentDoctorInput): Promise<boolean> {
  const ctx: AgentContext = input.ctx;
  const { project } = input;
  const environment = ctx.environment;
  const say = (check: string, answer: Answer, detail?: string) =>
    ctx.out(`${check}: ${answer}${detail === undefined ? "" : ` (${plain(detail)})`}\n`);
  const profile = agentProfile(WORKER_PROFILE);
  if (profile === undefined) ctx.fail(`there is no agent profile ${WORKER_PROFILE}`);

  // 1. The platform.
  const platform = ctx.platform ?? process.platform;
  say("platform supported", platform === "win32" ? "no" : "yes", platform);

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
  say("a terminal session can run", pty.ok ? "yes" : "no", pty.ok ? undefined : pty.reason);

  // 3. The program: found, its version, signed in.
  const which = ctx.which ?? ((name: string) => findOnPath(name, environment));
  const exec = ctx.exec ?? execChild;
  const at = program.includes("/") ? program : await which(program);
  say(`${profile.name} found`, at === undefined ? "no" : "yes", at ?? `${program} is not on PATH`);
  if (at !== undefined) {
    const printed = await exec(program, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS }).then(
      (result) => VERSION.exec(result.stdout)?.[0],
      () => undefined,
    );
    say(`${profile.name} version`, printed === undefined ? "unknown" : "yes", printed);
    const auth = await profile.authProbe(exec, ctx.now ?? Date.now);
    say(
      `${profile.name} signed in`,
      !auth.known ? "unknown" : auth.loggedIn ? "yes" : "no",
      auth.known && !auth.loggedIn ? "run claude auth login" : undefined,
    );
  }

  // 4. Trust of the folder the worktrees are made in.
  const config = await project.config().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, reason: reasonOf(error) }),
  );
  const readText =
    ctx.readText ?? ((path: string) => readFile(path, "utf8").catch(() => undefined));
  if (config.ok) {
    const dir = config.value.worktreesDir;
    const trust = await profile.trustProbe(dir, environment, readText);
    say(
      "worktrees folder trusted",
      trust === "trusted" ? "yes" : trust === "will_ask" ? "no" : "unknown",
      trust === "will_ask"
        ? `${dir}: start ${profile.program} in the project root once and accept; kodel never accepts it for you`
        : dir,
    );
  } else {
    say("worktrees folder trusted", "unknown", "the config cannot be read");
  }

  // 5. The decisions block.
  if (config.ok) {
    const decides = config.value.agentDecides;
    say(
      "decisions.dialog off",
      config.value.dialog ? "no" : "yes",
      config.value.dialog
        ? "a background agent cannot answer a dialog: no worker starts"
        : undefined,
    );
    say(
      "decisions.agent off",
      decides.length === 0 ? "yes" : "no",
      decides.length === 0
        ? undefined
        : `${decides.join(", ")}: a worker's own server never decides; an agent of kodel agent start uses the project's server, which may`,
    );
  } else {
    say("decisions.dialog off", "unknown", config.reason);
    say("decisions.agent off", "unknown");
  }

  // 6. The engines block against the committed one.
  say(
    "engines block as committed",
    found.state === "committed" ? "yes" : found.state === "differs" ? "no" : "unknown",
    found.state === "committed"
      ? `worker: ${mechanism}`
      : found.state === "failed"
        ? found.reason
        : found.state === "untracked"
          ? `git does not track .kodel/config.yaml; worker: ${mechanism}`
          : "kodel serve and the TUI start no agent until it is committed or put back",
  );
  for (const line of enginesQuestion(found).slice(1)) ctx.out(`${plain(line)}\n`);

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
  say("a worker can start", person.ok ? "yes" : "no", person.ok ? undefined : person.reason);
  if (person.ok) {
    const daemon = await verdict(true);
    if (!daemon.ok) say("kodel serve can start one", "no", daemon.reason);
  }
  return person.ok;
}
