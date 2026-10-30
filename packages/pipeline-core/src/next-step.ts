/**
 * What the agent is told next: a pure projection of the run state, with exactly four shapes
 * whatever node and check kinds are installed. In a fork several agent steps can be open at once:
 * `node` is the first one that is free, `steps` lists every open one, and `execution.mode` says how
 * the project wants them worked (one by one, or by one worker each).
 */
import { KodelError } from "./errors";
import type { PipelineSpec } from "./pipeline";
import type { AcceptEffect, NodeDiff } from "./pipeline-diff";
import { defaultRegistry, labelsOf, type Registry } from "./registry";
import { renderContextOf, renderTemplate } from "./render";
import {
  DEFAULT_CLAIM_TTL_S,
  type Feedback,
  type ForkRef,
  type ForkState,
  liveClaim,
  type RunState,
  type RunStatus,
  type Visit,
} from "./run";

/** Longest a single `pipeline_next_step` may wait, so a call never hangs for minutes. */
export const MAX_WAIT_S = 45;

// ── agents: how open steps are worked ───────────────────────────────────────

export type ExecutionMode = "parallel" | "sequential";

/** The `agents` block of the project config, as the engine reads it; a host parses and defaults it. */
export interface AgentsConfig {
  /**
   * Whether open steps of a fork are worked by subagents at once. `yes`/`no` decide; `auto` leaves
   * it to what the agent declares of itself on `pipeline_next_step`, and without a declaration the
   * steps are done one by one.
   */
  subagents: "auto" | "yes" | "no";
  /** How many open steps are handed out at once; the rest wait their turn. */
  max_parallel: number;
  /** How long a worker's hold on a step lasts unless renewed. */
  claim_ttl_s: number;
}

export const DEFAULT_AGENTS: AgentsConfig = {
  subagents: "auto",
  max_parallel: 8,
  claim_ttl_s: DEFAULT_CLAIM_TTL_S,
};

/** What the agent says of itself: whether it can start subagents, and how deep they nest. */
export interface SubagentsDeclaration {
  can: boolean;
  max_depth?: number;
}

/** The mode the steps are worked in: the config decides, else the agent's declaration, else one by one. */
export function resolveMode(
  config: Pick<AgentsConfig, "subagents"> | undefined,
  declared: SubagentsDeclaration | undefined,
): ExecutionMode {
  const setting = config?.subagents ?? "auto";
  if (setting === "yes") return "parallel";
  if (setting === "no") return "sequential";
  return declared?.can === true ? "parallel" : "sequential";
}

// ── the shapes ──────────────────────────────────────────────────────────────

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

/** One open agent step, as it is handed out: the same whoever else is working the run. */
export interface AgentStep {
  slug: string;
  name?: string;
  kind: string;
  attempt: number;
  prompt: string;
  reentry_feedback?: string;
  result_spec?: Record<string, unknown>;
  /** How to do the step (as opposed to what to do), when the node asks for something special. */
  execution?: { instruction: string };
  /**
   * Other ways this step may end, besides the usual one. Say which when you complete the
   * step (`outcome`); the checks still decide, and the prompt says when to use each.
   */
  outcomes?: string[];
  /** Where the work of this step is done, when that is not the directory the agent started in. */
  workdir?: string;
  /** A worker holds this step (a mark of the hold, not of who the worker is); leave it to them. */
  taken_by?: string;
}

/** A decision of a person that waits besides what the answer is about. */
export interface AlsoWaiting {
  reason: "gate" | "paused";
  node_slug: string;
  prompt: string;
  how_to_decide: { cli: string };
}

/** A step a worker holds, as a `running` answer lists it. */
export interface OpenStep {
  node_slug: string;
  attempt: number;
  taken_by?: string;
}

export type NextStep =
  | {
      node: AgentStep & {
        /** A change of this run's pipeline is waiting for the person; finish what you are doing. */
        pipeline_change?: PipelineChange;
        /**
         * How to do the step, and, with several steps open, how to work them: `mode` is `parallel`
         * (one worker per step) or `sequential` (one by one); the instruction says what each means.
         */
        execution?: { instruction: string; mode?: ExecutionMode };
        /** Every open agent step, this one first; absent when this is the only one. */
        steps?: AgentStep[];
        /** How many more open steps wait to be handed out (`agents.max_parallel`). */
        queued?: number;
        /** Decisions of a person that wait meanwhile; tell them when you report. */
        also_waiting?: AlsoWaiting[];
        /** Something about the run the agent has to know while it works this step. */
        note?: string;
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
        /**
         * Other branches of a fork were active while this step was reached or since: the files are one
         * tree, so `changes` may hold their writes too. Say so to the person; added by the host.
         */
        changes_note?: string;
        /** The other decisions that wait: name each of them to the person too. */
        also_waiting?: AlsoWaiting[];
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
        /** Agent steps that are open but held by workers (or, after a completion, open besides). */
        open_steps?: OpenStep[];
        /** Open steps not handed out because `agents.max_parallel` steps are held already. */
        queued?: number;
        also_waiting?: AlsoWaiting[];
        note?: string;
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

/**
 * A worker (a call that carries a claim token) never talks to the person and never watches the run:
 * it hands the answer to the agent that started it, which does both.
 */
const tellWorker = (waitHint: boolean) =>
  `You are a worker on one step of this run: do not write to the person${
    waitHint ? " and do not start `kodel wait`" : ""
  }. Report this answer as it is to the agent that started you, and stop.`;

/** The rules of working several open steps, one worker each. */
const parallelRules = (waitHint: boolean) =>
  "Several steps of this run are open at once (`steps`) and this project works them in parallel: " +
  "start one subagent per step in `steps` that has no `taken_by`, and give each worker these rules. " +
  "A worker calls pipeline_take_step with the run_id and its step's slug (node_slug) and keeps the " +
  "`claim_token` it gets; if the answer is `taken` (the step is another worker's) or `queued` (the " +
  "project's cap on steps worked at once is reached), it stops and reports that answer back. It does " +
  "the step where the step's `workdir` says (or where you work, if the step has none), then calls " +
  "pipeline_complete_step with node_slug, attempt and that claim_token, and reports the answer back " +
  "to you as it is, whether it says `node` (its own step again), `waiting`, `running`, `done` or " +
  `\`also_waiting\`; a worker never writes to the person${
    waitHint ? " and never starts `kodel wait`" : ""
  }. When your workers are back, call pipeline_next_step yourself: it hands out what is open ` +
  "then, and what waits for a person is told to you, not to the workers.";

/** The rules of working several open steps one by one. */
const SEQUENTIAL_RULES =
  "Several steps of this run are open at once (`steps`) and this project works them one by one: " +
  "do the step in `node` and hand it in with pipeline_complete_step (node_slug and attempt), then " +
  "call pipeline_next_step for the next open step. Do not take the steps with pipeline_take_step: a " +
  "claim is a worker's mark, and a step you held would not be handed to you again without its " +
  "node_slug. Do not start subagents for the other steps.";

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
  /** How open steps are worked (the host resolves the config and the agent's declaration). */
  agents?: { mode: ExecutionMode; maxParallel: number };
  /** Where the run's work is done, as the host names it for the agent, when not where it started. */
  workdir?: string;
  /** Exactly this open agent step, whoever holds it; refused when it is not one. */
  nodeSlug?: string;
  /**
   * The answer follows the completion of this node: it shows that node's own step again when the
   * checks sent it back, and never hands the caller a sibling's step (a `running` summary instead).
   */
  completionOf?: string;
  /** The caller is a worker (it handed in a claim token): it reports back instead of writing to the person. */
  worker?: boolean;
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
  also: AlsoWaiting[] | undefined,
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
      ...(also === undefined ? {} : { also_waiting: also }),
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
  if (options.worker === true) return forWorker(step, spec, state, now, options);
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

/**
 * A worker is told to report, whatever the answer; it is never offered the person's decisions, and
 * it is handed no step but its own again (what its completion opened, a fork or a successor, is the
 * starting agent's to hand out: the worker has no claim on it).
 */
function forWorker(
  step: NextStep,
  spec: PipelineSpec,
  state: RunState,
  now: number,
  options: NextStepOptions,
): NextStep {
  const tell = tellWorker(options.waitHint !== false);
  if ("waiting" in step) return { waiting: { ...step.waiting, tell_the_person: tell } };
  if ("done" in step) return { ...step, tell_the_person: tell };
  if ("running" in step) {
    // The plain hint tells whoever asked to wait or to talk to the person: neither is a worker's.
    return {
      running: {
        ...step.running,
        hint: `Your step is handed in; the engine is still working on this run (\`active\`), and that is not yours to wait for. ${tell}`,
      },
    };
  }
  if (!("node" in step)) return step;
  const { slug, steps, pipeline_change, also_waiting, note } = step.node;
  if (slug === options.completionOf && steps === undefined) return step;
  return {
    running: {
      ...(pipeline_change === undefined ? {} : { pipeline_change }),
      ...runningBody(spec, state, now),
      hint: `Your step is handed in and other steps are open (\`open_steps\`); they are not yours. ${tell}`,
      open_steps: openStepsOf(state, now),
      ...(also_waiting === undefined ? {} : { also_waiting }),
      ...(note === undefined ? {} : { note }),
    },
  };
}

/** Every open agent step with the mark of the worker that holds it, for a `running` summary. */
function openStepsOf(state: RunState, now: number): OpenStep[] {
  return state.active
    .filter((v) => v.phase === "agent")
    .map((v) => {
      const claim = liveClaim(state.nodes[v.node], now);
      return {
        node_slug: v.node,
        attempt: v.attempt,
        ...(claim === undefined ? {} : { taken_by: claim.by }),
      };
    });
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
  const step = baseStep(spec, state, now, registry, waitHint, options);
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
      step.waiting.also_waiting,
    );
  }
  if ("node" in step) {
    if (blocking && options.atCompletion) {
      return changedWaiting(
        state.runId,
        waitHint,
        change,
        step.node.slug,
        "step",
        step.node.also_waiting,
      );
    }
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
  options: NextStepOptions,
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
  const gates = state.active.filter((v) => v.phase === "human");
  const gateCli = (slug: string) =>
    gates.length > 1
      ? `kodel gate approve|reject ${state.runId} --node ${slug} --reason "..."`
      : `kodel gate approve|reject ${state.runId} --reason "..."`;
  const resumeCli = (slug: string) =>
    state.pauses.length > 1
      ? `kodel resume ${state.runId} --node ${slug}`
      : `kodel resume ${state.runId}`;
  const pauseText = (slug: string, reason: keyof typeof PAUSE_TEXT) => {
    const failure = state.nodes[slug]?.lastFailure;
    const detail = failure ? ` Last failure: ${failure.reason}` : "";
    return `The run is paused: ${PAUSE_TEXT[reason]} ("${slug}").${detail}`;
  };
  const gatePrompt = (visit: Visit) => {
    const spec_ = node(visit.node);
    const begin = registry.node(spec_.kind)?.begin(spec_.params, render);
    return begin?.needs === "human" ? begin.prompt : "A decision is needed.";
  };
  /** Every decision that waits, but the one the answer is about. */
  const alsoWaiting = (except?: string): AlsoWaiting[] | undefined => {
    const list: AlsoWaiting[] = [
      ...gates
        .filter((v) => v.node !== except)
        .map((v) => ({
          reason: "gate" as const,
          node_slug: v.node,
          prompt: gatePrompt(v),
          how_to_decide: { cli: gateCli(v.node) },
        })),
      ...state.pauses
        .filter((p) => p.node !== except)
        .map((p) => ({
          reason: "paused" as const,
          node_slug: p.node,
          prompt: pauseText(p.node, p.reason),
          how_to_decide: { cli: resumeCli(p.node) },
        })),
    ];
    return list.length === 0 ? undefined : list;
  };
  const noteOf = (also: AlsoWaiting[] | undefined): string | undefined => {
    const parts = [deadBranchNote(state.forks), alsoWaitingNote(also)].filter(
      (part): part is string => part !== undefined,
    );
    return parts.length === 0 ? undefined : parts.join(" ");
  };

  // `paused` means nothing can move; a pause of one branch while another goes on is not this.
  const pause = state.status === "paused" ? state.pauses[0] : undefined;
  if (pause) {
    const also = alsoWaiting(pause.node);
    return {
      waiting: {
        reason: "paused",
        node_slug: pause.node,
        prompt: pauseText(pause.node, pause.reason),
        how_to_decide: { cli: resumeCli(pause.node) },
        tell_the_person:
          TELL_WHEN_PAUSED + alsoWaitingTell(also) + tellToWait(state.runId, waitHint),
        ...(also === undefined ? {} : { also_waiting: also }),
      },
    };
  }

  const open = state.active.filter((v) => v.phase === "agent");
  const stepOf = (visit: Visit): AgentStep => {
    const out = agentStep(spec, state, registry, render, visit);
    if (options.workdir !== undefined) out.workdir = options.workdir;
    const claim = liveClaim(state.nodes[visit.node], now);
    if (claim !== undefined) out.taken_by = claim.by;
    return out;
  };

  if (options.nodeSlug !== undefined) {
    const visit = exactStep(spec, state, open, options.nodeSlug);
    const also = alsoWaiting();
    const note = noteOf(also);
    return {
      node: {
        ...stepOf(visit),
        ...(also === undefined ? {} : { also_waiting: also }),
        ...(note === undefined ? {} : { note }),
      },
    };
  }

  if (open.length > 0) {
    const also = alsoWaiting();
    const note = noteOf(also);
    const summary = (hint: string): NextStep => ({
      running: {
        ...runningBody(spec, state, now),
        hint,
        open_steps: openStepsOf(state, now),
        ...(also === undefined ? {} : { also_waiting: also }),
        ...(note === undefined ? {} : { note }),
      },
    });
    // After a completion the caller is handed only what that completion opened (its own rework, the
    // step after it, the branches it forked): a step of another branch that was open already is a
    // sibling's, and is only named in a summary.
    const completed = options.completionOf;
    const visible =
      completed === undefined
        ? open
        : open.filter((v) => !isSibling(v, state.nodes[completed]?.fork));
    if (visible.length === 0) {
      return summary(
        "Your step is handed in. Other steps of this run are open (`open_steps`); they are not yours " +
          "to pick here: call pipeline_next_step (without node_slug) to be handed what is open, or " +
          "report back if you are a worker.",
      );
    }
    const taken = visible.filter((v) => liveClaim(state.nodes[v.node], now) !== undefined);
    const free = visible.filter((v) => liveClaim(state.nodes[v.node], now) === undefined);
    if (free.length === 0) {
      return summary(
        `Every open step is held by a worker (${taken.length}); there is nothing for you to do until ` +
          `one hands in. Call pipeline_next_step again with wait_s (up to ${MAX_WAIT_S}) to wait for ` +
          "that, or wait for your workers to report. A step you hold yourself is handed to you " +
          "again when you ask for it with node_slug.",
      );
    }
    const maxParallel = Math.max(1, options.agents?.maxParallel ?? DEFAULT_AGENTS.max_parallel);
    // The cap counts every step in flight, a sibling's too: after a completion only `visible` is
    // handed out, but the steps held in other branches are worked all the same.
    const held = open.filter((v) => liveClaim(state.nodes[v.node], now) !== undefined).length;
    if (held >= maxParallel) {
      // The cap is on the steps in flight, not on the size of the answer: nothing is handed out
      // (and `pipeline_take_step` refuses a take by slug the same way) until a step is handed in.
      const capped = summary(
        `Every step this project lets be worked at once is held by a worker (agents.max_parallel is ${maxParallel}; ` +
          `${held} held, ${free.length} more open and queued). Call pipeline_next_step again with wait_s (up to ${MAX_WAIT_S}) ` +
          "to wait for a hand-in, or wait for your workers to report. A step you hold yourself is handed to you " +
          "again when you ask for it with node_slug.",
      );
      if ("running" in capped) capped.running.queued = free.length;
      return capped;
    }
    const handed = free.slice(0, maxParallel - held);
    const first = handed[0] as Visit;
    const out = stepOf(first);
    if (visible.length > 1) {
      const mode = options.agents?.mode ?? "sequential";
      const rules = mode === "parallel" ? parallelRules(waitHint) : SEQUENTIAL_RULES;
      const steps = [...handed, ...taken].map(stepOf);
      const queued = free.length - handed.length;
      return {
        node: {
          ...out,
          execution: {
            instruction: out.execution ? `${out.execution.instruction}\n\n${rules}` : rules,
            mode,
          },
          steps,
          ...(queued > 0 ? { queued } : {}),
          ...(also === undefined ? {} : { also_waiting: also }),
          ...(note === undefined ? {} : { note }),
        },
      };
    }
    return {
      node: {
        ...out,
        ...(also === undefined ? {} : { also_waiting: also }),
        ...(note === undefined ? {} : { note }),
      },
    };
  }

  const humanVisit = gates[0];
  if (humanVisit) {
    const spec_ = node(humanVisit.node);
    const begin = registry.node(spec_.kind)?.begin(spec_.params, render);
    const also = alsoWaiting(humanVisit.node);
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
        how_to_decide: { cli: gateCli(spec_.slug) },
        tell_the_person:
          (begin?.needs === "human" && begin.results
            ? `${TELL_AT_GATE} ${TELL_RESULTS}`
            : TELL_AT_GATE) +
          alsoWaitingTell(also) +
          tellToWait(state.runId, waitHint),
        ...(also === undefined ? {} : { also_waiting: also }),
      },
    };
  }

  const also = alsoWaiting();
  const note = noteOf(also);
  const body = runningBody(spec, state, now);
  return {
    running: {
      ...body,
      hint: runningHint(body.active),
      ...(also === undefined ? {} : { also_waiting: also }),
      ...(note === undefined ? {} : { note }),
    },
  };
}

/**
 * Whether an open step belongs to another branch of the fork the completed node was in: then it was
 * open before the completion and is somebody else's. The forking node itself and the join stand
 * outside the branches, so what they open is theirs to hand out.
 */
function isSibling(visit: Visit, completedIn: ForkRef | undefined): boolean {
  return (
    visit.fork !== undefined &&
    completedIn !== undefined &&
    visit.fork.id === completedIn.id &&
    visit.fork.branch !== completedIn.branch
  );
}

/** The open agent step named by `pipeline_next_step`'s `node_slug`, or a precise refusal. */
function exactStep(spec: PipelineSpec, state: RunState, open: Visit[], slug: string): Visit {
  const found = open.find((v) => v.node === slug);
  if (found) return found;
  if (!spec.nodes.some((n) => n.slug === slug)) {
    throw new KodelError("UNKNOWN_NODE", `the pipeline has no node "${slug}"`);
  }
  const visit = state.active.find((v) => v.node === slug);
  throw new KodelError(
    "NODE_NOT_RUNNING",
    visit
      ? `node "${slug}" is not an open agent step (it is in the ${visit.phase} phase)`
      : `node "${slug}" is not an open agent step; call pipeline_next_step without node_slug to see what is open`,
  );
}

function agentStep(
  spec: PipelineSpec,
  state: RunState,
  registry: Registry,
  render: (text: string) => string,
  visit: Visit,
): AgentStep {
  const spec_ = spec.nodes.find((n) => n.slug === visit.node);
  if (!spec_) throw new Error(`unknown node ${visit.node}`);
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
  const run = state.nodes[visit.node];
  const failure = run?.lastFailure;
  const out: AgentStep = {
    slug: spec_.slug,
    kind: spec_.kind,
    attempt: visit.attempt,
    prompt: parts.filter(Boolean).join("\n\n"),
  };
  if (spec_.name !== undefined) out.name = spec_.name;
  // A join that was reached after failures names every failed branch; its own rework (a check of
  // the join failed) is said as for any node. Compared by value: the state is written and read back
  // between the entry and this answer, so two objects say nothing about being the same failure.
  const branches = run?.lastFailures ?? [];
  const first = branches[0];
  const branchList =
    spec_.join !== undefined && first
      ? `Branches of the fork failed: ${branches.map(describeFailure).join("; ")}`
      : undefined;
  if (branchList !== undefined && failure && sameFeedback(failure, first as Feedback)) {
    out.reentry_feedback = branchList;
  } else if (branchList !== undefined && failure?.source === "pipeline") {
    // An accepted change started the join again on its new definition: the new attempt starts over,
    // so it is told again what the branches it joins left to handle.
    out.reentry_feedback = `The pipeline was changed under this run: ${failure.reason}. ${branchList}`;
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
  return out;
}

/** The part of a `running` answer that every variant shares. */
function runningBody(spec: PipelineSpec, state: RunState, now: number) {
  const completed = Object.values(state.nodes).filter((n) => n.status === "passed").length;
  const active = state.active.map((v) => {
    const found = spec.nodes.find((n) => n.slug === v.node);
    const elapsed = Math.max(0, Math.round((now - v.startedAt) / 1000));
    const expected = found?.expected_duration;
    return {
      node_slug: v.node,
      attempt: v.attempt,
      kind: found?.kind ?? "unknown",
      elapsed_s: elapsed,
      ...(expected === undefined
        ? {}
        : { expected_s: expected, remaining_s: Math.max(0, expected - elapsed) }),
    };
  });
  return { active, completed_in_run: completed };
}

/** The text for a fork whose branch died: the run cannot end well, but the open steps are still worked. */
function deadBranchNote(forks: Record<string, ForkState> | undefined): string | undefined {
  const dead = Object.values(forks ?? {}).flatMap((fork) =>
    fork.branches.flatMap((branch) => {
      const arrival = fork.arrived[branch];
      if (!arrival?.dead) return [];
      const failure = arrival.failure;
      return [
        `branch "${branch}" failed at "${arrival.node}" (${failure?.source ?? "unknown"}): ${failure?.reason ?? arrival.label}`,
      ];
    }),
  );
  if (dead.length === 0) return undefined;
  return `A branch of the fork is dead (${dead.join("; ")}): finish the open steps; the run ends failed when the others have settled.`;
}

function alsoWaitingNote(also: AlsoWaiting[] | undefined): string | undefined {
  if (also === undefined) return undefined;
  return `Besides this, the run waits for a person: ${describeAlso(also)}. Tell them when you report; do not run those commands.`;
}

/** The addition to a waiting answer's text: the other decisions are named too. */
function alsoWaitingTell(also: AlsoWaiting[] | undefined): string {
  if (also === undefined) return "";
  return ` The person also has to decide, besides this one: ${describeAlso(also)}. Name each of these to them too, with its command.`;
}

const describeAlso = (also: AlsoWaiting[]) =>
  also
    .map(
      (a) => `${a.reason === "gate" ? "gate" : "pause"} "${a.node_slug}" (${a.how_to_decide.cli})`,
    )
    .join("; ");

const checkOf = (failure: Feedback) => (failure.check_id ? ` (${failure.check_id})` : "");

const sameFeedback = (a: Feedback, b: Feedback) =>
  a.source === b.source && a.reason === b.reason && a.from === b.from && a.check_id === b.check_id;

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
