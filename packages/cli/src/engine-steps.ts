/**
 * Whether this build runs engine steps (T-42): an agent node with `engine:` run by kodel itself as a
 * session. Off: every host is built without `engineSteps`, so a pipeline with an engine step is refused
 * before anything is written. Turned on in a one-line change once the dialog gate (TASK-KDJS D-B) and
 * the person-only `engines:` block (D-C) are on main. It is a constant of the build, not a variable of
 * the environment: an agent cannot switch it on.
 */
import type { HostOptions } from "@kodel-ai/local";
import { pipesAdapter } from "./agent-commands";

export const KODEL_ENGINE_STEPS = false;

/** Who the host is built for: the MCP server starts sessions; a person's command never does. */
export type EngineRole = "mcp" | "human";

/**
 * The options that let a host run engine steps, or none while the flag is off. Only `kodel mcp` starts a
 * session; a person's command (`gate`, `resume`, an accept) enters an engine step and returns at once,
 * and looks a session up on `resume`.
 */
export function engineHostOptions(
  role: EngineRole,
  context: {
    root: string;
    environment?: Record<string, string | undefined>;
    launcher?: { exec: string; args: string[] };
  },
  enabled: boolean = KODEL_ENGINE_STEPS,
): Pick<HostOptions, "engine" | "engineSessions" | "engineStepsOffReason"> {
  if (!enabled) return {};
  // A session lives under the state base, and the guard of a `kodel mcp` in the engine's child looks for it
  // under the default one: the holder gives the child KODEL_ENGINE=1 and no other KODEL_* variable, so no
  // KODEL_STATE_DIR. With another base the guard would not find it, so engine steps are not run at all.
  const given = (context.environment ?? process.env).KODEL_STATE_DIR;
  if (given !== undefined && given !== "") {
    return {
      engineStepsOffReason:
        "KODEL_STATE_DIR is set, and an engine step's session would be kept where the guard of a kodel mcp started by its program does not look",
    };
  }
  const launcher = context.launcher ?? {
    exec: process.execPath,
    args: [process.argv[1] ?? "kodel"],
  };
  return {
    engine: { engineSteps: { start: role === "mcp" } },
    engineSessions: ({ rules, bootTimeoutMs }) =>
      pipesAdapter({
        root: context.root,
        ...(context.environment === undefined ? {} : { environment: context.environment }),
        launcher,
        rules,
        bootTimeoutMs,
      }),
  };
}
