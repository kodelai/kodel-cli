/**
 * Engine profiles (`engines:` of the project config, T-42): the programs that run the steps whose node
 * says `engine: <profile>`. The person's block, like `decisions`: the agent never changes it. This file
 * turns a profile into the launch of a session (argv, cwd, an environment built from an allow-list, a
 * timeout) and says which literal values of that environment are redacted from everything kept.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  DEFAULT_ENGINE_TIMEOUT_S,
  ENGINE_PROFILE_NAME,
  type EngineLaunch,
  type EngineLaunchRequest,
  type EngineResolver,
  type RedactRule,
  redactText,
} from "@kodel-ai/pipeline-core";
import { z } from "zod";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The variables of the host's environment every engine step gets, when they are set. */
export const ENGINE_BASE_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
] as const;

/** A literal value shorter than this, or one that looks like a path, is not redacted (a stated gap). */
export const MIN_SECRET_CHARS = 12;

/**
 * Variables a profile may not set or pass: they move where kodel keeps its state. A `kodel mcp` the
 * engine's program starts looks for the step's session under the state base its environment names; with
 * another HOME it would look elsewhere, find none and serve its tools.
 */
export const ENGINE_RESERVED_ENV = ["HOME", "USERPROFILE"] as const;

const reservedEnv = (name: string): string | undefined =>
  name.startsWith("KODEL_")
    ? "KODEL_ variables are kodel's own"
    : (ENGINE_RESERVED_ENV as readonly string[]).includes(name)
      ? `${name} moves where kodel keeps its state (a kodel started by the engine's program would not find the step's session); it is the server's own`
      : undefined;

const envName = z
  .string()
  .regex(ENV_NAME, "an environment variable name is letters, digits and _")
  .superRefine((name, ctx) => {
    const why = reservedEnv(name);
    if (why !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: why });
  });

/** How a background worker of a run is started: in a terminal of its own, or as a print process that ends at a wait. */
export const WORKER_MECHANISMS = ["terminal", "print"] as const;
export type WorkerMechanism = (typeof WORKER_MECHANISMS)[number];

/**
 * The engines that can be a worker (T-45), and the flags the person's `terminal.command` may add for each.
 * Everything else on that command is refused: it is an argv kodel starts unattended, with its own flags
 * (the permission mode, the tool lists, the one MCP server) beside it.
 */
export const WORKER_ENGINES: Readonly<Record<string, { terminalFlags: readonly string[] }>> = {
  claude: { terminalFlags: ["--model", "--effort", "--fallback-model"] },
};

/** What a profile says about a worker: the two keys only a worker engine may carry. */
export interface WorkerSettings {
  worker?: WorkerMechanism;
  terminal?: { command?: readonly string[] };
}

export interface TerminalCommand {
  program: string;
  pairs: { flag: string; value: string }[];
}

/**
 * Reads a `terminal.command`: the program, then pairs of an allowed flag and its value (`--flag value`
 * or `--flag=value`). A bare word, a value that begins with `-`, and any other flag (a short form too)
 * are refused by name.
 */
export function parseTerminalCommand(
  command: readonly string[],
  allowed: readonly string[],
): { ok: true; command: TerminalCommand } | { ok: false; problem: string } {
  const refuse = (problem: string) => ({ ok: false as const, problem });
  const program = command[0];
  if (program === undefined || program === "") return refuse("the program is missing");
  if (program.startsWith("-")) {
    return refuse(`the first element is the program, and "${program}" is a flag`);
  }
  const may = `it may add ${allowed.length === 0 ? "no flag" : allowed.join(", ")}`;
  const pairs: TerminalCommand["pairs"] = [];
  for (let i = 1; i < command.length; i += 1) {
    const element = command[i] ?? "";
    if (!element.startsWith("-")) {
      return refuse(`"${element}" is a bare word: only a flag and its value follow the program`);
    }
    const eq = element.startsWith("--") ? element.indexOf("=") : -1;
    const flag = eq < 0 ? element : element.slice(0, eq);
    if (!allowed.includes(flag)) return refuse(`the flag "${flag}" is not allowed (${may})`);
    let value: string | undefined;
    if (eq < 0) {
      i += 1;
      value = command[i];
    } else {
      value = element.slice(eq + 1);
    }
    if (value === undefined || value === "") return refuse(`the flag "${flag}" has no value`);
    if (value.startsWith("-")) {
      return refuse(`the value of "${flag}" ("${value}") begins with -`);
    }
    pairs.push({ flag, value });
  }
  return { ok: true, command: { program, pairs } };
}

export const engineProfileSchema = z
  .object({
    /**
     * The program of an engine step and its fixed arguments; the prompt comes last, as one argument
     * after `--`. Absent on a profile that only says how a worker is started: such a profile runs no step.
     */
    command: z.array(z.string().min(1)).min(1).optional(),
    /** How a background worker of a run is started (T-45). Only on a profile that can be a worker. */
    worker: z.enum(WORKER_MECHANISMS).optional(),
    /** The program of a terminal worker and the flags the person adds to it (`parseTerminalCommand`). */
    terminal: z
      .object({ command: z.array(z.string().min(1)).min(1).optional() })
      .strict()
      .optional(),
    /** How the program is told the node's `model`, for example `--model`. */
    model_flag: z.string().min(1).optional(),
    /** Literal values for the step's environment; long ones are redacted from what is kept. */
    env: z.record(envName, z.string()).optional(),
    /** Names of the host's variables passed on as they are; long values are redacted from what is kept. */
    pass_env: z.array(envName).optional(),
    /** Seconds a step may run when its node does not say; 3600 if absent. */
    timeout: z.number().int().positive().max(86_400).optional(),
  })
  .strict();

export type EngineProfile = z.infer<typeof engineProfileSchema>;

/** Why only some profile names may carry `worker:` or `terminal:` (decision 2 of TASK-EKAV). */
export const ONLY_CLAUDE_IS_A_WORKER =
  "only claude can be a worker in this version; codex and opencode are a follow-up task";

export const enginesSchema = z
  .record(
    z.string().regex(ENGINE_PROFILE_NAME, "a profile name is lowercase letters, digits, - and _"),
    engineProfileSchema,
  )
  .superRefine((profiles, ctx) => {
    for (const [name, profile] of Object.entries(profiles)) {
      if (profile.worker === undefined && profile.terminal === undefined) continue;
      const engine = Object.hasOwn(WORKER_ENGINES, name) ? WORKER_ENGINES[name] : undefined;
      if (engine === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `engines.${name}: ${ONLY_CLAUDE_IS_A_WORKER}`,
        });
        continue;
      }
      const command = profile.terminal?.command;
      if (command === undefined) continue;
      const parsed = parseTerminalCommand(command, engine.terminalFlags);
      if (!parsed.ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name, "terminal", "command"],
          message: `engines.${name}.terminal.command: ${parsed.problem}`,
        });
      }
    }
  });

const PATH_START = /^(\/|~\/|\.{1,2}\/|[A-Za-z]:[\\/])/;
const PATH_SEGMENT = /^[A-Za-z0-9._ -]*$/;

/**
 * A value that is a path of this machine, and so is not redacted (a gap, said in docs/engines.md): it
 * starts as a path does, every segment is a plain word, and it is there on disk. A token with a `/` in it
 * (base64) is none of that and is redacted.
 */
export const isRealPath = (
  value: string,
  exists: (path: string) => boolean = existsSync,
): boolean => {
  if (!PATH_START.test(value)) return false;
  const segments = value.replace(/^([A-Za-z]:|~)/, "").split(/[\\/]+/);
  if (!segments.every((s) => PATH_SEGMENT.test(s))) return false;
  try {
    return exists(value.startsWith("~/") ? value.replace("~", homedir()) : value);
  } catch {
    return false;
  }
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The redaction rules for the literal values of a step's environment: each value, and its JSON-escaped
 * form when that differs, so neither the output nor a record written as JSON keeps it.
 */
export function literalRules(secrets: string[]): RedactRule[] {
  const rules: RedactRule[] = [];
  for (const [i, secret] of secrets.entries()) {
    // Also with `/` written `\/`, as some JSON writers do.
    const json = JSON.stringify(secret).slice(1, -1);
    const forms = new Set([secret, json, json.replaceAll("/", "\\/")]);
    for (const form of forms) {
      rules.push({ name: `engine-env-${i + 1}`, pattern: new RegExp(escapeRegExp(form), "g") });
    }
  }
  return rules;
}

/** The values of an environment worth redacting as literals: long enough, and not a path. */
export function secretsOf(
  values: string[],
  exists: (path: string) => boolean = existsSync,
): string[] {
  return [...new Set(values.filter((v) => v.length >= MIN_SECRET_CHARS && !isRealPath(v, exists)))];
}

/**
 * The hash a started session is journaled with: of the redacted argv, the names of the environment and
 * the working directory. A changed profile shows as another hash; the values never reach it.
 */
export function launchHash(launch: EngineLaunch, rules: RedactRule[]): string {
  const text = JSON.stringify({
    argv: launch.argv.map((a) => redactText(a, rules)),
    env: Object.keys(launch.env).sort(),
    cwd: launch.cwd,
  });
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Why the config cannot be read, without the parser's own text: that may quote the line, and the line
 * may hold a value of `env:`. Only where (the file, and the line when the parser says it) is said.
 */
export function configProblem(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const file = /^(.*?config\.ya?ml)/.exec(message)?.[1];
  const line = /\bline (\d+)/.exec(message)?.[1] ?? /:(\d+):\d+/.exec(message)?.[1];
  return `the project config cannot be read${file === undefined ? "" : ` (${file}${line === undefined ? "" : `, line ${line}`})`}; run a kodel command in a terminal to see why`;
}

/**
 * The resolver of a host: the profile is read from the live config at each start (`profiles`), so a
 * profile taken out of the config stops the next start; the environment is the allow-list, `pass_env`
 * and the profile's own `env`, never the rest of the host's.
 */
export function configEngineResolver(
  profiles: () => Promise<Record<string, EngineProfile>>,
  hostEnv: () => Record<string, string | undefined> = () => process.env,
): EngineResolver {
  return {
    async resolve(request: EngineLaunchRequest, where: { cwd: string }) {
      let all: Record<string, EngineProfile>;
      try {
        all = await profiles();
      } catch (error) {
        return { ok: false, reason: configProblem(error) };
      }
      const profile = Object.hasOwn(all, request.profile) ? all[request.profile] : undefined;
      if (profile === undefined) {
        return {
          ok: false,
          reason: `the engine profile "${request.profile}" is not in engines: of the project config`,
        };
      }
      // Checked again at the launch: a profile handed in by another caller than the config is held to it too.
      for (const name of [...Object.keys(profile.env ?? {}), ...(profile.pass_env ?? [])]) {
        const why = reservedEnv(name);
        if (why !== undefined) {
          return {
            ok: false,
            reason: `the engine profile "${request.profile}" sets ${name}: ${why}`,
          };
        }
      }
      const command = profile.command;
      if (command === undefined) {
        return {
          ok: false,
          reason: `the engine profile "${request.profile}" has no command: it says how a worker is started and runs no step`,
        };
      }
      if (request.model !== undefined && profile.model_flag === undefined) {
        return {
          ok: false,
          reason: `the step asks for a model, and the engine profile "${request.profile}" has no model_flag to pass it`,
        };
      }
      const host = hostEnv();
      const env: Record<string, string> = {};
      for (const name of ENGINE_BASE_ENV) {
        const value = host[name];
        if (value !== undefined) env[name] = value;
      }
      const missing: string[] = [];
      const literal: string[] = [];
      for (const name of profile.pass_env ?? []) {
        const value = host[name];
        if (value === undefined) missing.push(name);
        else {
          env[name] = value;
          literal.push(value);
        }
      }
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `pass_env of the engine profile "${request.profile}" names ${missing.join(", ")}, which the server's environment does not have`,
        };
      }
      for (const [name, value] of Object.entries(profile.env ?? {})) {
        env[name] = value;
        literal.push(value);
      }
      const argv = [
        ...command,
        ...(request.model !== undefined && profile.model_flag !== undefined
          ? [profile.model_flag, request.model]
          : []),
        "--",
        request.prompt,
      ];
      const seconds = request.timeout ?? profile.timeout ?? DEFAULT_ENGINE_TIMEOUT_S;
      return {
        ok: true,
        launch: {
          argv,
          cwd: where.cwd,
          env,
          timeoutMs: seconds * 1000,
          secrets: secretsOf(literal),
        },
      };
    },
  };
}
