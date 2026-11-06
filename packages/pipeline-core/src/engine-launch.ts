/**
 * An engine step (T-42): an agent node with `engine:` whose work the engine runs itself, as a session
 * (`SessionAdapter`) named after the run, the visit and the attempt. Pure: the names, the outcome
 * table, the result contract and the texts; the host starts, joins and reads the session.
 *
 * Never twice: one open record per run (`RunState.engineSession`) is written before `start()`, and an
 * outcome that cannot be proven fails the attempt as "unknown", which only a person's `resume` passes.
 */
import { z } from "zod";
import type { Feedback } from "./run";
import type { SessionErrorCode, SessionStatus } from "./session";

/** What the core hands the host for an engine step: the profile, the model and the prompt. */
export interface EngineLaunchRequest {
  /** A profile of `engines:` in the project config. */
  profile: string;
  model?: string;
  /** The rendered prompt with the instructions of the checks and the feedback of a retry. */
  prompt: string;
  /** Seconds the node allows (its `timeout` or `defaults.timeout`); the profile's comes next. */
  timeout?: number;
}

/** What the host made of a request: the program as a session will run it. */
export interface EngineLaunch {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Literal values the step's environment holds that are long enough to redact (`pass_env`, the profile's `env`). */
  secrets: string[];
}

/** Turns a request into a launch; the host's (`packages/local`), refusing with a reason. */
export interface EngineResolver {
  resolve(
    request: EngineLaunchRequest,
    where: { cwd: string },
  ): Promise<{ ok: true; launch: EngineLaunch } | { ok: false; reason: string }>;
}

/** The open record of the run's engine session, kept in the state (format 2). */
export interface EngineSessionRecord {
  node: string;
  attempt: number;
  visitId: number;
  /** The session's name (`engineSessionName`): what a later process finds it by. */
  name: string;
  /** Set once `start()` answered (`engine_session_started`). */
  id?: string;
}

/** The longest prompt an engine step sends (one argv element). */
export const MAX_ENGINE_PROMPT_BYTES = 64 * 1024;
/** The longest result an engine step may print; a longer one fails the step (it is never cut and then read). */
export const MAX_ENGINE_RESULT_BYTES = 128 * 1024;
/** The bytes a host reads of the output: one more than the cap, so an output over it is seen as such. */
export const ENGINE_RESULT_READ_BYTES = MAX_ENGINE_RESULT_BYTES + 1;
/** How long an engine step may run when neither the node nor the profile says (1 hour). */
export const DEFAULT_ENGINE_TIMEOUT_S = 3_600;

/** The first words of the reason of an attempt whose outcome is unknown; only the engine writes them. */
export const ENGINE_UNKNOWN_PREFIX = "outcome unknown, a person decides";

/** The name of the session of an attempt: `ke-<run id>-<visit id>-<attempt>`. */
export function engineSessionName(runId: string, visitId: number, attempt: number): string {
  return `ke-${runId}-${visitId}-${attempt}`.toLowerCase();
}

/** The prompt as the engine's program gets it: the step, what the checks ask, and why a retry. */
export function enginePrompt(
  prompt: string,
  instructions: string[],
  failure: Feedback | undefined,
): string {
  const parts = [prompt, ...instructions];
  if (failure) {
    parts.push(
      failure.source === "human"
        ? `A person sent this back${failure.from ? ` at "${failure.from}"` : ""}: ${failure.reason}`
        : failure.source === "pipeline"
          ? `The pipeline was changed under this run: ${failure.reason}`
          : `The previous attempt failed (${failure.source}): ${failure.reason}`,
    );
  }
  return parts.filter((p) => p !== "").join("\n\n");
}

/** The result an engine step prints on stdout: one JSON object with a string `summary` or `result`. */
export const engineResultSchema = z
  .object({ summary: z.string().optional(), result: z.string().optional() })
  .passthrough()
  .refine((r) => r.summary !== undefined || r.result !== undefined, {
    message: "the object has no string summary or result",
  });

export type EngineResultParse = { ok: true; summary: string } | { ok: false; reason: string };

/** Reads a step's stdout. Nothing is cut: an output over the cap fails, it is never cut and then read. */
export function parseEngineResult(stdout: string, complete = true): EngineResultParse {
  const bytes = new TextEncoder().encode(stdout).length;
  if (!complete || bytes > MAX_ENGINE_RESULT_BYTES) {
    return { ok: false, reason: `the output is over ${MAX_ENGINE_RESULT_BYTES / 1024} KiB` };
  }
  const text = stdout.trim();
  if (text === "") return { ok: false, reason: "the step printed nothing" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the output is not one JSON object" };
  }
  const parsed = engineResultSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      reason:
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? "the output has no string summary or result"
          : "the output is not one JSON object",
    };
  }
  return { ok: true, summary: parsed.data.summary ?? parsed.data.result ?? "" };
}

/** What a start that threw leads to: a full `list()` decides, except where the code alone does. */
export const START_ERROR_OUTCOME = {
  UNKNOWN: "list",
  NOT_FOUND: "list",
  CANNOT_READ: "list",
  NEWER_FORMAT: "list",
  NAME_TAKEN: "list",
  // The name was used by a session that is gone: the attempt ran before.
  NAME_USED: "unknown",
  SPEC_INVALID: "list",
  PLATFORM_UNSUPPORTED: "list",
  IDENTITY_UNKNOWN: "list",
  HOLDER_BOOT_FAILED: "list",
  STATE_UNWRITABLE: "list",
  NOT_RUNNING: "list",
  STILL_RUNNING: "list",
  UNSUPPORTED: "list",
} as const satisfies Record<SessionErrorCode, "list" | "unknown">;

export type EngineOutcome =
  | { kind: "result"; summary: string }
  | { kind: "failed"; reason: string }
  | { kind: "unknown"; reason: string }
  | { kind: "running" };

/**
 * The outcome table. A result needs `exited`, code 0, the child gone and an output read whole within
 * the cap that holds a result; a failure needs a proven end (a code, a kill); everything else is
 * unknown. Never a result or a failure while the child is alive.
 */
export function engineOutcome(
  status: SessionStatus,
  output?: { text: string; complete: boolean },
): EngineOutcome {
  if (status.childAlive === true) return { kind: "unknown", reason: "its child is still alive" };
  if (status.state === "starting" || status.state === "running") return { kind: "running" };
  if (status.state === "lost") {
    return { kind: "unknown", reason: `the session was lost (${status.reason ?? "no reason"})` };
  }
  if (status.state === "killed") {
    return {
      kind: "failed",
      reason: `the step was killed (${status.reason ?? status.signal ?? "no reason given"})`,
    };
  }
  if (status.exitCode !== 0) {
    return {
      kind: "failed",
      reason:
        status.exitCode === undefined
          ? "the step ended without an exit code"
          : `the step exited with code ${status.exitCode}`,
    };
  }
  if (output === undefined) return { kind: "unknown", reason: "its output could not be read" };
  const parsed = parseEngineResult(output.text, output.complete);
  return parsed.ok
    ? { kind: "result", summary: parsed.summary }
    : { kind: "failed", reason: parsed.reason };
}

/** The reason of an unknown attempt: the fixed prefix, the session and what the person can do. */
export function unknownReason(
  why: string,
  session: { id?: string; name: string },
  newerFormat = false,
): string {
  const handle = session.id ?? session.name;
  return (
    `${ENGINE_UNKNOWN_PREFIX}: ${why}. The session is ${handle}` +
    `${session.id === undefined ? " (by name)" : ""}: look at it with \`kodel agent logs ${handle}\`, ` +
    `stop it with \`kodel agent stop ${handle}\` if it still runs, then \`kodel resume\` runs the step again` +
    (newerFormat ? "; it was written by a newer kodel: upgrade kodel" : "")
  );
}

/** A reason that came from the step's own output never reads as the engine's word that it is unknown. */
export function neutralizeReason(reason: string): string {
  return reason.trimStart().toLowerCase().startsWith(ENGINE_UNKNOWN_PREFIX)
    ? `the step said: ${reason}`
    : reason;
}
