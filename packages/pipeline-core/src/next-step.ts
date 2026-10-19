/**
 * What the agent is told next: a pure projection of the run state, with exactly four shapes
 * whatever node and check kinds are installed.
 */
import type { PipelineSpec } from "./pipeline";
import { defaultRegistry, type Registry } from "./registry";
import { renderTemplate } from "./render";
import type { RunState, RunStatus, Visit } from "./run";

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
      };
    }
  | {
      running: {
        active: { node_slug: string; attempt: number; kind: string; elapsed_s: number }[];
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
      },
    };
  }

  const completed = Object.values(state.nodes).filter((n) => n.status === "passed").length;
  return {
    running: {
      active: state.active.map((v) => ({
        node_slug: v.node,
        attempt: v.attempt,
        kind: node(v.node).kind,
        elapsed_s: Math.max(0, Math.round((now - v.startedAt) / 1000)),
      })),
      completed_in_run: completed,
      hint: "The engine is running this; there is nothing for you to do. Tell the user and end your turn, or ask again later.",
    },
  };
}
