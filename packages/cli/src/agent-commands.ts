import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  forgetName,
  PipesSessionAdapter,
  readMarker,
  resolveBase,
  sessionDirOf,
} from "@kodel-ai/local";
import {
  foldSessionName,
  isSessionName,
  SessionError,
  type SessionListEntry,
} from "@kodel-ai/pipeline-core";
import type { Command } from "commander";
import { plain } from "./plain";
import { formatTable } from "./table";

/** Commands that refuse under `KODEL_ENGINE` (and need a terminal): the set a test walks. */
export const AGENT_HUMAN_COMMANDS = [
  "agent stop",
  "agent rm",
  "agent exec",
  "agent forget-name",
] as const;
/** Commands an agent may run: they only read. */
export const AGENT_READ_COMMANDS = ["agent ls"] as const;

export interface AgentContext {
  cwd: string;
  out(text: string): void;
  environment: Record<string, string | undefined>;
  /** The project root and a way to fail with a message and no stack trace. */
  root(): Promise<string>;
  fail(message: string): never;
  requireHuman(): void;
  mustConfirm(question: string): Promise<void>;
  /** How to start the holder processes; the CLI's own entry by default. */
  launcher?: { exec: string; args: string[] };
}

const detailOf = (entry: SessionListEntry): string => {
  if (entry.problem)
    return entry.problem === "NEWER_FORMAT" ? "written by a newer kodel" : "cannot be read";
  const s = entry.status;
  if (s.state === "exited") return `exit ${s.exitCode ?? 0}`;
  if (s.state === "killed") return s.reason ?? s.signal ?? "killed";
  if (s.state === "lost") return `${s.reason ?? "lost"}${s.childAlive ? ", child alive" : ""}`;
  return "";
};

export function registerAgentCommands(
  program: Command,
  withPlural: (c: Command) => Command,
  ctx: AgentContext,
): void {
  const launcher = ctx.launcher ?? { exec: process.execPath, args: [process.argv[1] ?? "kodel"] };
  const adapter = async (): Promise<PipesSessionAdapter> =>
    new PipesSessionAdapter({
      base: resolveBase(ctx.environment),
      root: await ctx.root(),
      baseEnv: ctx.environment,
      holder: { exec: launcher.exec, args: [...launcher.args, "session-holder", "holder"] },
      intermediate: { exec: launcher.exec, args: [...launcher.args, "session-holder"] },
    });

  // Before anything else, also before the check for a person: the answer on Windows is the same for everyone.
  const platform = (): void => {
    if (process.platform === "win32")
      ctx.fail("PLATFORM_UNSUPPORTED: agents are not supported on Windows yet");
  };

  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SessionError) ctx.fail(`${error.code}: ${plain(error.message)}`);
      throw error;
    }
  };

  const agent = withPlural(program.command("agent")).description(
    "Agents the project runs in the background (long-running processes)",
  );

  agent
    .command("ls")
    .description("List the agents of this project")
    .option("--json", "print the list as JSON")
    .option("--no-headers", "do not print the header row")
    .action(async (opts: { json?: boolean; headers?: boolean }) => {
      platform();
      const rows = await guard(async () => (await adapter()).list());
      if (opts.json) {
        ctx.out(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      if (rows.length === 0) {
        ctx.out("no agents\n");
        return;
      }
      const table = rows.map((r) => [
        plain(r.id),
        plain(r.name ?? "-"),
        r.status.state,
        plain(detailOf(r)),
      ]);
      for (const line of formatTable(
        ["ID", "NAME", "STATE", "DETAIL"],
        table,
        opts.headers !== false,
      )) {
        ctx.out(`${line}\n`);
      }
    });

  agent
    .command("stop <id>")
    .description("Stop an agent and the processes it started")
    .action(async (id: string) => {
      platform();
      ctx.requireHuman();
      await ctx.mustConfirm(`Stop agent ${plain(id)}?`);
      const status = await guard(async () => (await adapter()).stop(id));
      ctx.out(`${plain(id)}: ${status.state}${status.reason ? ` (${status.reason})` : ""}\n`);
    });

  agent
    .command("rm <id>")
    .description("Remove a finished agent")
    .action(async (id: string) => {
      platform();
      ctx.requireHuman();
      await ctx.mustConfirm(`Remove agent ${plain(id)}? Its name stays used.`);
      await guard(async () => (await adapter()).remove(id));
      ctx.out(`${plain(id)}: removed\n`);
    });

  agent
    .command("exec <command...>", { hidden: true })
    .description("Run a command as an agent (for trying the sessions by hand)")
    .option("--name <name>", "a name to find it again by")
    .option("--pty", "run it in a terminal of its own (not in this build)")
    .allowUnknownOption()
    .action(async (command: string[], opts: { name?: string; pty?: boolean }) => {
      platform();
      ctx.requireHuman();
      if (opts.pty) ctx.fail("UNSUPPORTED: a terminal session is not in this build");
      if (opts.name !== undefined && !isSessionName(opts.name)) ctx.fail("the name is not valid");
      const started = await guard(async () =>
        (await adapter()).start({
          argv: command,
          cwd: ctx.cwd,
          ...(opts.name !== undefined ? { name: opts.name } : {}),
        }),
      );
      ctx.out(`started ${plain(started.id)}${started.name ? ` (${plain(started.name)})` : ""}\n`);
    });

  agent
    .command("forget-name <name>", { hidden: true })
    .description("Free a name that a finished agent still holds (a retry may run again)")
    .action(async (name: string) => {
      platform();
      ctx.requireHuman();
      if (!isSessionName(name)) ctx.fail("the name is not valid");
      await ctx.mustConfirm(
        `Free the name ${plain(name)}? A step that is retried under it may run its command again.`,
      );
      const place = (await adapter()).place;
      const marker = readMarker(join(place.namesDir, `${foldSessionName(name)}.json`));
      if (marker === "newer") ctx.fail("the marker was written by a newer kodel; upgrade kodel");
      if (typeof marker !== "string" && existsSync(sessionDirOf(place, marker.id))) {
        ctx.fail(`the session ${plain(marker.id)} still exists; remove it first (kodel agent rm)`);
      }
      const freed = forgetName(place.namesDir, foldSessionName(name));
      ctx.out(freed ? `${plain(name)}: freed\n` : `${plain(name)}: was not used\n`);
    });
}
