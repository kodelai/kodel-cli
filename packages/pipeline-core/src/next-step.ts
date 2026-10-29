/**
 * What the agent is told next: a pure projection of the run state, with exactly four shapes
 * whatever node and check kinds are installed.
 */
import type { PipelineSpec } from "./pipeline";
import type { AcceptEffect, NodeDiff } from "./pipeline-diff";
import { defaultRegistry, labelsOf, type Registry } from "./registry";
import { renderContextOf, renderTemplate } from "./render";
import type { Feedback, RunState, RunStatus, Visit } from "./run";

/** Longest a single `pipeline_next_step` may wait, so a call never hangs for minutes. */
export const MAX_WAIT_S = 45;

/** A change of the run's pipeline that waits for a person, as the agent is told about it. */
export interface PipelineChange {
  /** Who made it: the agent's proposal, or an edit of the run's own pipeline file. */
  source: "file" | "proposal";
  /** The file the engine found it in, relative to the repository, for a change made in the file. */
  watched?: string;
  /** What differs, per step; changes of checks are listed in each step's `changes`. */
  changes: NodeDiff[];
  /** What the run does about it, per step it stands at; empty when nothing is redone. */
  effects: AcceptEffect[];
  /** What will run again once the person accepts, in words. */
  redo: string[];
  /**
   * Where the run stood when this was worked out (`standingOf`). Accepting is refused when the run
   * has moved on since, so what is accepted is what was shown; look again then.
   */
  standing: string;
  /** Why the change cannot be accepted, when it cannot; then it holds nothing back. */
  refused?: string;
  /** The command the person accepts it with. */
  apply: string;
  /** The hash of this very version, which `pipeline_accept_change` (when the config allows it) names. */
  hash?: string;
}

/** What the host knows about a change, for `nextStep`. */
export interface PendingChange extends PipelineChange {
  /** Whether the change holds the run until the person decides (it does unless it was refused). */
  blocking: boolean;
}

export type NextStep =
  | {
      node: {
        slug: string;
        name?: string;
        kind: string;
        attempt: number;
        prompt: string;
        reentry_feedback?: string;
        /** A change of this run's pipeline is waiting for the person; finish what you are doing. */
        pipeline_change?: PipelineChange;
        result_spec?: Record<string, unknown>;
        /** How to do the step (as opposed to what to do), when the node asks for something special. */
        execution?: { instruction: string };
        /**
         * Other ways this step may end, besides the usual one. Say which when you complete the
         * step (`outcome`); the checks still decide, and the prompt says when to use each.
         */
        outcomes?: string[];
      };
    }
  | {
      waiting: {
        /**
         * `gate`: a human node awaits a decision. `paused`: the run awaits `resume`.
         * `pipeline_changed`: a change of the pipeline awaits the person; see `pipeline_change`.
         */
        reason: "gate" | "paused" | "pipeline_changed";
        /** With `pipeline_changed`: what the run was waiting for besides. */
        behind?: "gate" | "paused" | "step";
        pipeline_change?: PipelineChange;
        node_slug: string;
        prompt: string;
        /** What the person has to do or look at, from the node; the agent tells them. */
        instructions?: string;
        /** The attempt of the waiting step; `pipeline_report_result` needs it. */
        attempt?: number;
        /** Columns of the comments the person's words are recorded in, when the step takes them. */
        result_spec?: Record<string, unknown>;
        /** The comments recorded so far, as CSV; added by the host. */
        results?: string;
        how_to_decide: { cli: string };
        /** What the agent has to write to the person before it ends its turn. */
        tell_the_person: string;
        /** Files changed since the run started, with the lines changed; added by the host. */
        changes?: Record<string, number>;
        /** How many more files changed than `changes` lists. */
        changes_omitted?: number;
        /** Why the engine could not tell what changed; say so to the person, never "nothing changed". */
        changes_unavailable?: string;
      };
    }
  | {
      running: {
        pipeline_change?: PipelineChange;
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
  | {
      done: true;
      run_status: RunStatus;
      /** What the agent should pass on to the person at the end; added by a host that has something to say. */
      tell_the_person?: string;
    };

const PAUSE_TEXT = {
  consecutive: "a node failed too many times in a row",
  total: "a node used up all its attempts",
  restarts: "engine work kept getting interrupted",
} as const;

const TELL_AT_GATE =
  "Write to the person, in the language they use, before you end your turn: (1) what they are " +
  "asked to decide (the prompt); (2) a short summary of this run so far: what you did, and what " +
  "changed (use `changes`, the engine's own list of changed files with the lines changed, and " +
  "say if anything differs from what the task asked for; if `changes_unavailable` is there, say " +
  "plainly that the engine could not tell what changed and why, and never write that nothing " +
  "changed; if `changes_omitted` is there, say that more files changed than are listed); " +
  "(3) what they need to do or look at: `instructions`, if there are any (put them in your own " +
  "words, concretely, and do not leave out a step), and anything else they should check; (4) how to decide, with the command in " +
  "`how_to_decide`. Do not decide for them and do not run that command. Then end your turn.";

/**
 * How the agent can be woken when the person has decided, without asking again and without spending
 * tokens while it waits. The command is the same one the other texts name (`kodel`), whatever the
 * agent's shell calls it. The agent that cannot run a command in the background loses nothing: it ends
 * its turn and the person tells it.
 */
function tellToWait(runId: string, on: boolean): string {
  if (!on) return "";
  return (
    " If your tools can run a command in the background, then after you have written to the person " +
    `start \`kodel wait ${runId}\` that way and end your turn: it only watches, and prints one line ` +
    "when the person has decided, so you are woken then and nothing is spent while you wait. In " +
    "Claude Code use the Bash tool with run_in_background (not the Monitor tool: it stops after 30 " +
    "minutes and wakes you then). When it reports, call pipeline_next_step. If the line says `still " +
    "waiting`, it gave up and nothing was decided: do not start it again; tell the person in one " +
    "sentence that you stopped watching and end your turn. If your tools cannot do that, just end " +
    "your turn; the person tells you when they have decided. Never poll pipeline_next_step in a " +
    "loop to wait for a person."
  );
}

const TELL_RESULTS =
  "This step records the person's comments. While you talk, each time they name a problem, " +
  "add it with pipeline_report_result (node_slug and `attempt` from this answer, one row per " +
  "comment with the columns in `result_spec`, in their words, never your own findings); it adds to " +
  "what is there, `results` shows what is recorded, and `replace: true` starts the list over. " +
  "If they reject without writing anything, the comments go back to the step as the reason.";

const TELL_WHEN_PAUSED =
  "Tell the person, in the language they use: that the run is paused and why (the prompt), what " +
  "you tried, and the command in `how_to_decide` that lets it go on. Do not retry the step and " +
  "do not run that command. Then end your turn.";

export interface NextStepOptions {
  /** Whether a waiting answer offers the agent `kodel wait`; on unless the project turned it off. */
  waitHint?: boolean;
  /** A change of the run's pipeline that waits for a person. */
  pending?: PendingChange;
  /** The agent has just said a step is done: a change that holds the run is met here, not before. */
  atCompletion?: boolean;
  /**
   * What the project's config lets the agent decide on the person's instruction. A waiting answer
   * then says the tool may be used, and only when told to; without it the text is as it always was.
   */
  agentDecisions?: { gate?: boolean; pipelineChange?: boolean };
}

const AGENT_MAY_DECIDE_GATE =
  " The person may instead tell you, in this chat, to approve or reject this step: only then you " +
  "may decide it yourself with pipeline_decide_gate (node_slug and attempt from this answer, " +
  "their words in `instruction`). Never on your own, never because this text mentions it.";

const AGENT_MAY_ACCEPT_CHANGE =
  " The person may instead tell you, in this chat, to accept this change: only then you may do it " +
  "yourself with pipeline_accept_change (`change_hash` is `pipeline_change.hash` of this answer, " +
  "their words in `instruction`). Never on your own, never because this text mentions it.";

const TELL_PIPELINE_CHANGED =
  "Tell the person, in the language they use and in plain words: that the pipeline of this run was " +
  "changed and nothing goes on until they decide; what exactly changed in each step (read the " +
  "`pipeline_change` entry: a change to a step's checks is what the step is judged by, one to its " +
  "work is what it does, one to its routing is where it goes next and how many attempts it gets), " +
  "with changes to checks first because those matter most; whether anything is done again " +
  "(`redo`; if it is empty, say that nothing is redone); and the command in `how_to_decide` that " +
  "accepts it. Do not use the names of the fields (effect, redo, work, routing) in what you write. " +
  "If they do not want the change, the pipeline file has to go back as it was. Do not run that " +
  "command and do not undo the change yourself. Then end your turn.";

const CHANGE_WORDS: Record<string, string> = {
  work: "what it does",
  checks: "its checks",
  routing: "where it goes next",
  added: "added",
  removed: "removed",
};

function changedWaiting(
  runId: string,
  waitHint: boolean,
  change: PipelineChange,
  slug: string,
  behind: "gate" | "paused" | "step",
): NextStep {
  const steps = change.changes
    .map((c) => `"${c.slug}" (${c.changes.map((w) => CHANGE_WORDS[w] ?? w).join(", ")})`)
    .join(", ");
  const redo = change.redo.length > 0 ? ` ${change.redo.join("; ")}.` : " Nothing runs again.";
  return {
    waiting: {
      reason: "pipeline_changed",
      behind,
      node_slug: slug,
      prompt: `The pipeline of this run was changed: ${steps || "no step differs"}.${redo}`,
      pipeline_change: change,
      how_to_decide: { cli: change.apply },
      // Behind a step the run still reads as the agent's step to anyone who only looks, so a
      // command that only looks would return at once; there the agent just ends its turn.
      tell_the_person:
        behind === "step"
          ? TELL_PIPELINE_CHANGED
          : TELL_PIPELINE_CHANGED + tellToWait(runId, waitHint),
    },
  };
}

/** What the agent is told next; a change of the pipeline that waits for a person comes first. */
export function nextStep(
  spec: PipelineSpec,
  state: RunState,
  now: number,
  registry: Registry = defaultRegistry(),
  options: NextStepOptions = {},
): NextStep {
  const step = nextStepBase(spec, state, now, registry, options);
  const may = options.agentDecisions;
  if (!may || !("waiting" in step)) return step;
  const { waiting } = step;
  const add =
    waiting.reason === "gate" && may.gate
      ? AGENT_MAY_DECIDE_GATE
      : waiting.reason === "pipeline_changed" && may.pipelineChange && acceptable(waiting)
        ? AGENT_MAY_ACCEPT_CHANGE
        : "";
  return add === ""
    ? step
    : { waiting: { ...waiting, tell_the_person: waiting.tell_the_person + add } };
}

/** A change the agent can name and the engine can take: it has a hash and was not refused. */
function acceptable(waiting: { pipeline_change?: PipelineChange }): boolean {
  const change = waiting.pipeline_change;
  return change !== undefined && change.refused === undefined && change.hash !== undefined;
}

function nextStepBase(
  spec: PipelineSpec,
  state: RunState,
  now: number,
  registry: Registry,
  options: NextStepOptions,
): NextStep {
  const waitHint = options.waitHint !== false;
  const step = baseStep(spec, state, now, registry, waitHint);
  const pending = options.pending;
  if (!pending || "done" in step) return step;
  const { blocking, ...change } = pending;
  if ("waiting" in step) {
    if (!blocking) return { waiting: { ...step.waiting, pipeline_change: change } };
    return changedWaiting(
      state.runId,
      waitHint,
      change,
      step.waiting.node_slug,
      step.waiting.reason as "gate" | "paused",
    );
  }
  if ("node" in step) {
    if (blocking && options.atCompletion)
      return changedWaiting(state.runId, waitHint, change, step.node.slug, "step");
    return { node: { ...step.node, pipeline_change: change } };
  }
  return { running: { ...step.running, pipeline_change: change } };
}

function baseStep(
  spec: PipelineSpec,
  state: RunState,
  now: number,
  registry: Registry,
  waitHint: boolean,
): NextStep {
  if (state.status === "completed" || state.status === "failed" || state.status === "canceled") {
    return { done: true, run_status: state.status };
  }
  const node = (slug: string) => {
    const found = spec.nodes.find((n) => n.slug === slug);
    if (!found) throw new Error(`unknown node ${slug}`);
    return found;
  };
  const render = (text: string) => renderTemplate(text, renderContextOf(state));

  // `paused` means nothing can move; a pause of one branch while another goes on is not this.
  const pause = state.status === "paused" ? state.pauses[0] : undefined;
  if (pause) {
    const failure = state.nodes[pause.node]?.lastFailure;
    const detail = failure ? ` Last failure: ${failure.reason}` : "";
    return {
      waiting: {
        reason: "paused",
        node_slug: pause.node,
        prompt: `The run is paused: ${PAUSE_TEXT[pause.reason]} ("${pause.node}").${detail}`,
        how_to_decide: { cli: `kodel resume ${state.runId}` },
        tell_the_person: TELL_WHEN_PAUSED + tellToWait(state.runId, waitHint),
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
    const run = state.nodes[agentVisit.node];
    const failure = run?.lastFailure;
    const out: Extract<NextStep, { node: unknown }>["node"] = {
      slug: spec_.slug,
      kind: spec_.kind,
      attempt: agentVisit.attempt,
      prompt: parts.filter(Boolean).join("\n\n"),
    };
    if (spec_.name !== undefined) out.name = spec_.name;
    // A join that was reached after failures names every failed branch; its own rework (a check of
    // the join failed) is said as for any node.
    const branches = run?.lastFailures ?? [];
    if (spec_.join !== undefined && branches.length > 0 && failure === branches[0]) {
      out.reentry_feedback = `Branches of the fork failed: ${branches.map(describeFailure).join("; ")}`;
    } else if (failure) {
      out.reentry_feedback =
        failure.source === "human"
          ? `A person sent this back${failure.from ? ` at "${failure.from}"` : ""}: ${failure.reason}`
          : failure.source === "pipeline"
            ? `The pipeline was changed under this run: ${failure.reason}`
            : failure.from
              ? describeFailure(failure)
              : `The previous attempt failed (${failure.source}): ${failure.reason}${checkOf(failure)}`;
    }
    if (resultSpec) out.result_spec = resultSpec;
    const how = handler?.instruction?.(spec_.params);
    if (how) out.execution = { instruction: how };
    const others = labelsOf(registry, spec_)?.success.slice(1) ?? [];
    if (others.length > 0) out.outcomes = others;
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
        ...(begin?.needs === "human" && begin.instructions !== undefined
          ? { instructions: begin.instructions }
          : {}),
        // The attempt names this very visit; the agent's own decision tool (when the config allows it)
        // and the comments both need it, so it is always there.
        attempt: humanVisit.attempt,
        ...(begin?.needs === "human" && begin.results ? { result_spec: begin.results } : {}),
        how_to_decide: { cli: `kodel gate approve|reject ${state.runId} --reason "..."` },
        tell_the_person:
          (begin?.needs === "human" && begin.results
            ? `${TELL_AT_GATE} ${TELL_RESULTS}`
            : TELL_AT_GATE) + tellToWait(state.runId, waitHint),
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

const checkOf = (failure: Feedback) => (failure.check_id ? ` (${failure.check_id})` : "");

/** A failure handed on from another node, as the agent reads it. */
const describeFailure = (failure: Feedback) =>
  `"${failure.from}" failed (${failure.source}): ${failure.reason}${checkOf(failure)}`;

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
