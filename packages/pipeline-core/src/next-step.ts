/**
 * What the agent is told next: a pure projection of the run state, with exactly four shapes
 * whatever node and check kinds are installed.
 */
import type { PipelineSpec } from "./pipeline";
import { defaultRegistry, type Registry } from "./registry";
import { renderTemplate } from "./render";
import type { RunState, RunStatus, Visit } from "./run";

/** Longest a single `pipeline_next_step` may wait, so a call never hangs for minutes. */
export const MAX_WAIT_S = 60;

export type NextStep =
  | {
      node: {
        slug: string;
        name?: string;
        kind: string;
        attempt: number;
        prompt: string;
        reentry_feedback?: string;
        result_spec?: Record<string, unknown>;
        /** How to do the step (as opposed to what to do), when the node asks for something special. */
        execution?: { instruction: string };
      };
    }
  | {
      waiting: {
        /** `gate`: a human node awaits a decision. `paused`: the run awaits `resume`. */
        reason: "gate" | "paused";
        node_slug: string;
        prompt: string;
        files?: string[];
        how_to_decide: { cli: string };
        /** What the agent has to write to the person before it ends its turn. */
        tell_the_person: string;
        /** Files changed since the run started, with the lines changed; added by the host. */
        changes?: Record<string, number>;
      };
    }
  | {
      running: {
        active: {
          node_slug: string;
          attempt: number;
          kind: string;
          elapsed_s: number;
          /** From the node's `expected_duration`, when it has one. */
          expected_s?: number;
          /** Roughly how much of that is left (0 when it is overdue). */
          remaining_s?: number;
        }[];
        completed_in_run: number;
        hint: string;
      };
    }
  | { done: true; run_status: RunStatus };

const PAUSE_TEXT = {
  consecutive: "a node failed too many times in a row",
  total: "a node used up all its attempts",
  restarts: "engine work kept getting interrupted",
} as const;

const TELL_AT_GATE =
  "Write to the person, in the language they use, before you end your turn: (1) what they are " +
  "asked to decide (the prompt); (2) a short summary of this run so far: what you did, and what " +
  "changed (use `changes`, the engine's own list of changed files with the lines changed, and " +
  "say if anything differs from what the task asked for); (3) what to look at: the files listed " +
  "and anything else they should check; (4) how to decide, with the command in " +
  "`how_to_decide`. Do not decide for them and do not run that command. Then end your turn.";

const TELL_WHEN_PAUSED =
  "Tell the person, in the language they use: that the run is paused and why (the prompt), what " +
  "you tried, and the command in `how_to_decide` that lets it go on. Do not retry the step and " +
  "do not run that command. Then end your turn.";

export function nextStep(
  spec: PipelineSpec,
  state: RunState,
  now: number,
  registry: Registry = defaultRegistry(),
): NextStep {
  if (state.status === "completed" || state.status === "failed" || state.status === "canceled") {
    return { done: true, run_status: state.status };
  }
  const node = (slug: string) => {
    const found = spec.nodes.find((n) => n.slug === slug);
    if (!found) throw new Error(`unknown node ${slug}`);
    return found;
  };
  const render = (text: string) => renderTemplate(text, { task: state.task });

  if (state.status === "paused" && state.pause) {
    const failure = state.nodes[state.pause.node]?.lastFailure;
    const detail = failure ? ` Last failure: ${failure.reason}` : "";
    return {
      waiting: {
        reason: "paused",
        node_slug: state.pause.node,
        prompt: `The run is paused: ${PAUSE_TEXT[state.pause.reason]} ("${state.pause.node}").${detail}`,
        how_to_decide: { cli: `kodel resume ${state.runId}` },
        tell_the_person: TELL_WHEN_PAUSED,
      },
    };
  }

  const needsAgent = (v: Visit) => v.phase === "agent";
  const agentVisit = state.active.find(needsAgent);
  if (agentVisit) {
    const spec_ = node(agentVisit.node);
    const handler = registry.node(spec_.kind);
    const begin = handler?.begin(spec_.params, render);
    const parts = [begin?.needs === "agent" ? begin.prompt : ""];
    let resultSpec: Record<string, unknown> | undefined;
    for (const check of spec_.checks) {
      const checkHandler = registry.check(check.kind);
      const text = checkHandler?.instruction?.(check.params);
      if (text) parts.push(text);
      if (checkHandler?.exposeSpec && resultSpec === undefined) resultSpec = check.params;
    }
    const failure = state.nodes[agentVisit.node]?.lastFailure;
    const out: Extract<NextStep, { node: unknown }>["node"] = {
      slug: spec_.slug,
      kind: spec_.kind,
      attempt: agentVisit.attempt,
      prompt: parts.filter(Boolean).join("\n\n"),
    };
    if (spec_.name !== undefined) out.name = spec_.name;
    if (failure) {
      const at = failure.from ? ` at "${failure.from}"` : "";
      out.reentry_feedback =
        failure.source === "human"
          ? `A person sent this back${at}: ${failure.reason}`
          : failure.from
            ? `"${failure.from}" failed (${failure.source}): ${failure.reason}`
            : `The previous attempt failed (${failure.source}): ${failure.reason}`;
    }
    if (resultSpec) out.result_spec = resultSpec;
    const how = handler?.instruction?.(spec_.params);
    if (how) out.execution = { instruction: how };
    return { node: out };
  }

  const humanVisit = state.active.find((v) => v.phase === "human");
  if (humanVisit) {
    const spec_ = node(humanVisit.node);
    const begin = registry.node(spec_.kind)?.begin(spec_.params, render);
    return {
      waiting: {
        reason: "gate",
        node_slug: spec_.slug,
        prompt: begin?.needs === "human" ? begin.prompt : "A decision is needed.",
        ...(begin?.needs === "human" && begin.files.length > 0 ? { files: begin.files } : {}),
        how_to_decide: { cli: `kodel gate approve|reject ${state.runId} --reason "..."` },
        tell_the_person: TELL_AT_GATE,
      },
    };
  }

  const completed = Object.values(state.nodes).filter((n) => n.status === "passed").length;
  const active = state.active.map((v) => {
    const elapsed = Math.max(0, Math.round((now - v.startedAt) / 1000));
    const expected = node(v.node).expected_duration;
    return {
      node_slug: v.node,
      attempt: v.attempt,
      kind: node(v.node).kind,
      elapsed_s: elapsed,
      ...(expected === undefined
        ? {}
        : { expected_s: expected, remaining_s: Math.max(0, expected - elapsed) }),
    };
  });
  return {
    running: {
      active,
      completed_in_run: completed,
      hint: runningHint(active),
    },
  };
}

function runningHint(active: { node_slug: string; remaining_s?: number }[]): string {
  const known = active.filter((a) => a.remaining_s !== undefined);
  const wait = (seconds: number) => Math.min(MAX_WAIT_S, Math.max(5, Math.ceil(seconds)));
  const base = "The engine is running this; there is nothing for you to do.";
  if (known.length === 0) {
    return `${base} Call pipeline_next_step again with wait_s (up to ${MAX_WAIT_S}) to wait for it, or tell the user and end your turn.`;
  }
  const longest = Math.max(...known.map((a) => a.remaining_s ?? 0));
  if (longest === 0) {
    return `${base} It is taking longer than expected. Call pipeline_next_step with wait_s: ${wait(15)} to keep waiting, or tell the user and end your turn.`;
  }
  return `${base} It should take about ${longest} more seconds. Call pipeline_next_step with wait_s: ${wait(longest + 3)} to wait for it, or tell the user and end your turn.`;
}
