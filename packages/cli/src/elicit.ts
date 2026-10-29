/**
 * Asking the person in the coding agent's own interface. When an answer to the agent would be
 * `waiting` for a person (a gate, a paused run, a change of the run's pipeline), or the state of a
 * run was changed outside kodel, the server sends `elicitation/create` to the client and applies
 * what the person answers there, as `kodel gate`, `resume`, `pipeline changes` and `ack` do in a
 * terminal. The answer comes from the client to this server; no tool takes a decision, and nothing
 * the agent sends is read as one.
 *
 * Fail closed: only an `accept` that fits the form we sent decides anything. A decline, a cancel,
 * a timeout, a client error, a form that does not fit, and anything that changed while the dialog
 * was open leave the run as it was, and the commands stay the way to decide.
 */
import type { ChangeReport, PendingFound } from "@kodel-ai/local";
import type {
  AgentDecision,
  Decision,
  PipelineService,
  PipelineSpec,
  RunState,
  ToolResult,
} from "@kodel-ai/pipeline-core";
import type { AfterTool, ToolCall } from "@kodel-ai/pipeline-core/mcp";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type ElicitRequestFormParams,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { describePendingChange, gateChangesText, gateCommentsText } from "./decide-text";
import { plain } from "./plain";

/** One run as far as the decisions need it; `LocalRun` is one. */
export interface HumanRun {
  state(): Promise<RunState>;
  currentSpec(): Promise<PipelineSpec>;
  pendingChange(state?: RunState, only?: "file" | "proposal"): Promise<PendingFound | undefined>;
  changesSinceGate(node: string): Promise<ChangeReport>;
  gateResults(node: string): Promise<{ csv: string; count: number } | undefined>;
  decideHuman(
    node: string,
    decision: "approved" | "rejected",
    reason?: string,
    byAgent?: AgentDecision,
  ): Promise<Decision>;
  /** `node`: which paused branch, when more than one is paused. */
  resume(node?: string): Promise<Decision>;
  acknowledge(note?: string): Promise<Decision>;
  acceptChange(input: {
    source: "file" | "proposal";
    text: string;
    reason?: string;
    byAgent?: AgentDecision;
    standing?: string;
  }): Promise<Decision>;
  discardProposal(): Promise<boolean>;
  restoreFile(hash?: string): Promise<{ path: string; hash: string }>;
}

/**
 * Who is deciding right now, so that the person's dialog and the agent's own decision tools never
 * decide the same thing at once. Both sides change it in the same tick as they look at it (no
 * `await` between), so exactly one of them wins: a dialog that starts while the agent is deciding is
 * skipped, and an agent decision that starts while a dialog is held is answered `waiting`.
 */
export interface DialogState {
  /** Dialogs held: from the moment an answer needs the person until it has been asked and applied. */
  open: number;
  /** Agent decisions being applied. */
  deciding: number;
}

export const newDialogState = (): DialogState => ({ open: 0, deciding: 0 });

/** A host that can also decide for a person (the local one); a host that cannot passes nothing. */
export interface HumanHost {
  open(runId: string): Promise<HumanRun | undefined>;
}

/**
 * How long a dialog may stay open: a person reads the changes before they answer. A client that
 * drops the call without cancelling it leaves the dialog, and the server's one question at a time,
 * for this long, so it is no longer than a person needs. After it, an answer that arrives is
 * dropped by the SDK: it belongs to a request that no longer exists.
 */
export const ELICIT_TIMEOUT_MS = 10 * 60_000;

/** How many times a form that does not fit is shown again before the question is given up. */
const MAX_ROUNDS = 3;

/** A gate, then the change of the pipeline it was held by, then the next one: no more than this. */
const MAX_CHAIN = 4;

/**
 * The tools whose answers can leave a decision to the person. The other tools (a proposal, a
 * report) must not be a way for the agent to open a dialog for itself.
 */
const DIALOG_TOOLS = new Set(["pipeline_start", "pipeline_next_step", "pipeline_complete_step"]);

/**
 * A change of the pipeline and a state changed outside kodel are what the agent can provoke again
 * and again (a new proposal, a new edit), so a run gets only this many dialogs of each that end
 * without the person deciding; the commands stay the way to decide after that.
 */
const MAX_PROVOKED = 3;

type Schema = ElicitRequestFormParams["requestedSchema"];

/** What came of a question. `applied` is the only one that changed the run. */
type Outcome =
  | { done: "applied"; said: string }
  | { done: "none"; answer: NoAnswer; message: string };

type NoAnswer =
  | "declined"
  | "cancelled"
  | "failed"
  | "unusable"
  | "stale"
  | "refused"
  | "asked"
  | "unknown";

type Verdict = Outcome | { retry: string };

interface Question {
  /** One question per visit: the same key is not asked twice by this server. */
  key: string;
  /** What the agent is told when the person did not decide here: how the person can decide. */
  notDecided: string;
  message(note?: string): string;
  schema: Schema;
  /** Checks the form and, if it fits, applies the decision; `retry` shows the form again. */
  apply(content: Record<string, unknown>): Promise<Verdict>;
}

type Wanted =
  | { kind: "gate" | "paused" | "change"; waiting: Record<string, unknown> }
  | { kind: "ack"; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max = 2000): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const none = (answer: NoAnswer, message: string): Outcome => ({ done: "none", answer, message });
const stale = (why: string): Outcome =>
  none("stale", `${why}. Nothing was decided; look at the run again.`);
const refusedBy = (decision: Extract<Decision, { ok: false }>): Outcome =>
  none("refused", `the engine refused it: ${plain(decision.error.message)}`);

/** What the agent is told when the person did not decide in the dialog. */
const NOT_DECIDED =
  "The person was asked in a dialog and did not decide there, so the run is as it was. Do what `tell_the_person` says; the command in `how_to_decide` is still the way to decide.";

/**
 * The person answered but applying it threw: the journal or the state may or may not have been
 * written, so the agent is not told that nothing changed; it is shown the run as it is.
 */
const UNKNOWN =
  "The person answered in the dialog, but it could not be confirmed whether their decision was applied. What follows is the run as it is now: believe it, not an earlier answer.";

function runIdOf(call: ToolCall): string | undefined {
  const fromArgs = call.args["run_id"];
  if (typeof fromArgs === "string") return fromArgs;
  const fromResult = (call.result as Record<string, unknown>)["run_id"];
  return typeof fromResult === "string" ? fromResult : undefined;
}

/** What, if anything, the answer to the agent leaves to a person. */
function wanted(result: ToolResult): Wanted | undefined {
  const body = result as Record<string, unknown>;
  if (body["ok"] === false) {
    const message = String(body["message"] ?? "");
    // The same code also says a finished run was changed (`kodel seal`): not asked here.
    return body["code"] === "STATE_MODIFIED_EXTERNALLY" && message.includes("kodel ack")
      ? { kind: "ack", message }
      : undefined;
  }
  const next = isRecord(body["next"]) ? body["next"] : body;
  // A change that waits for the person is also told to the agent as a note on the step it works on.
  const step = next["node"];
  if (isRecord(step) && isRecord(step["pipeline_change"])) return { kind: "change", waiting: {} };
  const waiting = next["waiting"];
  if (!isRecord(waiting)) return undefined;
  switch (waiting["reason"]) {
    case "gate":
      return { kind: "gate", waiting };
    case "paused":
      return { kind: "paused", waiting };
    case "pipeline_changed":
      return { kind: "change", waiting };
    default:
      return undefined;
  }
}

/**
 * The hook for `registerPipelineTools`. It does nothing unless the client declared it can show a
 * form, and it asks one question at a time.
 */
export function createElicitor(
  server: Server,
  humans: HumanHost,
  service: PipelineService,
  options: { timeoutMs?: number; state?: DialogState } = {},
): AfterTool {
  const timeout = options.timeoutMs ?? ELICIT_TIMEOUT_MS;
  const asked = new Set<string>();
  /** Dialogs of the kinds the agent can provoke that ended without a decision, per run and kind. */
  const unanswered = new Map<string, number>();
  let busy = false;

  async function ask(question: Question, signal: AbortSignal): Promise<Outcome> {
    let note: string | undefined;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let reply: Awaited<ReturnType<Server["elicitInput"]>>;
      try {
        reply = await server.elicitInput(
          { mode: "form", message: question.message(note), requestedSchema: question.schema },
          { timeout, signal },
        );
      } catch (error) {
        // An answer that does not fit the form is the SDK's refusal (invalid params): the person
        // is shown the form again, the same as when the server finds the answer unusable.
        if (
          !signal.aborted &&
          error instanceof McpError &&
          error.code === ErrorCode.InvalidParams
        ) {
          note = "the answer did not fit the form.";
          continue;
        }
        // The client went away, refused the request, or timed out.
        return signal.aborted
          ? none("cancelled", question.notDecided)
          : none("failed", `${question.notDecided} The dialog failed or timed out.`);
      }
      if (reply.action === "decline") return none("declined", question.notDecided);
      if (reply.action === "cancel") return none("cancelled", question.notDecided);
      const verdict = await question
        .apply(reply.content ?? {})
        .catch((): Verdict => none("unknown", UNKNOWN));
      if ("retry" in verdict) {
        note = verdict.retry;
        continue;
      }
      return verdict;
    }
    return none("unusable", `${question.notDecided} The answers did not fit the form.`);
  }

  /** The answer with the run as it is now next to what the person did (or may have done). */
  async function withFreshState(
    call: ToolCall,
    result: ToolResult,
    kind: Wanted["kind"],
    dialog: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (kind === "ack") return { ...result, dialog } as ToolResult;
    const runId = runIdOf(call);
    // If the state cannot be read now, the agent still hears what the person did. The question is
    // asked as the caller asked it: with `node_slug` the answer is about that step, the agent's
    // declaration of itself (`subagents`) decides the mode as before, and after a completion the
    // answer stays that completion's (its own step again or a summary, never a sibling's step).
    const nodeSlug = call.args["node_slug"];
    const declared = call.args["subagents"];
    const completing = call.tool === "pipeline_complete_step" && typeof nodeSlug === "string";
    const fresh =
      runId === undefined
        ? undefined
        : await service
            .nextStep({
              run_id: runId,
              ...(call.tool === "pipeline_next_step" && typeof nodeSlug === "string"
                ? { node_slug: nodeSlug }
                : {}),
              ...(isRecord(declared) && typeof declared["can"] === "boolean"
                ? { subagents: { can: declared["can"] } }
                : {}),
              ...(completing
                ? {
                    after_completion: {
                      node_slug: nodeSlug,
                      worker: typeof call.args["claim_token"] === "string",
                    },
                  }
                : {}),
            })
            .catch(() => undefined);
    if (!fresh?.ok) return { ...result, dialog } as ToolResult;
    const { ok: _ok, ...step } = fresh;
    if (call.tool === "pipeline_next_step") return { ok: true, ...step, dialog };
    return { ...result, next: step, dialog } as ToolResult;
  }

  const decidedNote = (kind: Wanted["kind"], said: string) => ({
    answer: "decided",
    what: said,
    message:
      kind === "ack"
        ? "A person accepted the state of the run in a dialog. The call you made did not run: make it again."
        : "A person decided this in a dialog; what follows is the state after their decision.",
  });

  async function build(runId: string, run: HumanRun, what: Wanted): Promise<Question | undefined> {
    switch (what.kind) {
      case "gate":
        return gateQuestion(
          runId,
          run,
          text(what.waiting["node_slug"], 200),
          text(what.waiting["prompt"], 1000),
        );
      case "paused":
        return pausedQuestion(runId, run, text(what.waiting["node_slug"], 200));
      case "change":
        return changeQuestion(runId, run);
      case "ack":
        return ackQuestion(runId, run, what.message);
    }
  }

  async function handle(call: ToolCall, claim: () => boolean): Promise<ToolResult | undefined> {
    const runId = runIdOf(call);
    if (runId === undefined) return undefined;
    const run = await humans.open(runId);
    if (!run) return undefined;
    let result = call.result;
    let changed = false;
    for (let link = 0; link < MAX_CHAIN; link++) {
      const what = wanted(result);
      if (!what) break;
      // The agent is deciding this itself right now: no form for something already being decided.
      if (!claim()) break;
      const question = await build(runId, run, what);
      if (!question) break;
      const provoked = what.kind === "change" || what.kind === "ack";
      const spent = `${runId}|${what.kind}`;
      if (asked.has(question.key) || (provoked && (unanswered.get(spent) ?? 0) >= MAX_PROVOKED)) {
        result = {
          ...result,
          dialog: { answer: "asked", message: question.notDecided },
        } as ToolResult;
        changed = true;
        break;
      }
      asked.add(question.key);
      const outcome = await ask(question, call.signal);
      changed = true;
      // The call was cancelled or the connection dropped: the person may never have seen the dialog.
      if (outcome.done === "none" && call.signal.aborted) asked.delete(question.key);
      else if (outcome.done === "none" && provoked) {
        unanswered.set(spent, (unanswered.get(spent) ?? 0) + 1);
      }
      if (outcome.done === "applied") unanswered.delete(spent);
      if (outcome.done === "none") {
        const dialog = { answer: outcome.answer, message: outcome.message };
        // When it is not known whether the decision was applied, the agent gets the run as it is.
        result =
          outcome.answer === "unknown"
            ? await withFreshState(call, result, what.kind, dialog)
            : ({ ...result, dialog } as ToolResult);
        break;
      }
      // The same question may come up again later (a run paused twice at one step): this one is over.
      asked.delete(question.key);
      result = await withFreshState(call, result, what.kind, decidedNote(what.kind, outcome.said));
      if (what.kind === "ack") break;
    }
    return changed ? result : undefined;
  }

  return async (call) => {
    if (!DIALOG_TOOLS.has(call.tool)) return undefined;
    // A worker (a call that hands in a claim token) is never held for the person: the agent that
    // started it talks to them. The token, not `node_slug`, is the mark: every completion names a
    // node, and the one of a run worked by one agent is where the gate dialog belongs.
    if (typeof call.args["claim_token"] === "string") return undefined;
    if (!server.getClientCapabilities()?.elicitation?.form) return undefined;
    if (busy) return undefined;
    busy = true;
    // Held from the first look at an answer that needs the person until the last form is dealt with.
    const state = options.state;
    let held = false;
    const claim = () => {
      if (!state) return true;
      if (state.deciding > 0) return false;
      if (!held) {
        state.open++;
        held = true;
      }
      return true;
    };
    try {
      return await handle(call, claim);
    } finally {
      busy = false;
      if (held && state) state.open--;
    }
  };
}

const header = (runId: string, rest: string, note?: string) =>
  [note === undefined ? undefined : `Not applied: ${note}`, `Run ${plain(runId)}: ${rest}`]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");

const NOT_THE_AGENT =
  "Only you decide this: the agent cannot, and what it wrote below is only its wording.";

/**
 * What the person was shown about the files, as a value to compare with what is true when they
 * answer: the changed files and their lines in a fixed order, and only the kind when the engine
 * could not tell (its wording is not part of the facts).
 */
function changesFingerprint(found: ChangeReport): string {
  if (found.kind !== "changes") return found.kind;
  return JSON.stringify(
    Object.entries(found.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

const SHOWN_COMMENTS = 20;
const SHOWN_COMMENT_CHARS = 300;

/** What the agent recorded is shown in the dialog cut to a size a person reads: the first rows, each cut. */
function boundedComments(comments: { csv: string; count: number }): {
  csv: string;
  count: number;
} {
  const lines = comments.csv.split("\n");
  const shown = lines
    .slice(0, SHOWN_COMMENTS + 1)
    .map((line) =>
      line.length > SHOWN_COMMENT_CHARS ? `${line.slice(0, SHOWN_COMMENT_CHARS)}...` : line,
    );
  const more = lines.length - shown.length;
  return {
    count: comments.count,
    csv: more > 0 ? [...shown, `... and ${more} more`].join("\n") : shown.join("\n"),
  };
}

export async function blockingChange(run: HumanRun, state: RunState): Promise<boolean> {
  const found = await run.pendingChange(state).catch(() => undefined);
  return found?.info.blocking === true;
}

async function gateQuestion(
  runId: string,
  run: HumanRun,
  node: string,
  prompt: string,
): Promise<Question | undefined> {
  const state = await run.state();
  const visit = state.active.find((v) => v.node === node && v.phase === "human");
  if (!visit) return undefined;
  const found = await run.changesSinceGate(node);
  const comments = await run.gateResults(node);
  const unverified = found.kind === "unavailable";
  const properties: Schema["properties"] = {
    decision: {
      type: "string",
      title: "Decision",
      enum: ["approve", "reject"],
      enumNames: ["Approve", "Reject"],
    },
    reason: {
      type: "string",
      title: comments
        ? "Reason (optional: the recorded comments go back too)"
        : "Reason (needed to reject)",
      maxLength: 2000,
    },
    ...(unverified
      ? {
          confirm_unverified: {
            type: "boolean",
            title: "The engine could not check what changed; approve anyway",
            default: false,
          },
        }
      : {}),
  };
  return {
    key: `${runId}|gate|${node}|${visit.attempt}`,
    notDecided: NOT_DECIDED,
    schema: { type: "object", properties, required: ["decision"] },
    message: (note) =>
      header(
        runId,
        [
          `the step "${plain(node)}" waits for your decision.`,
          prompt ? `Asked of you (step text): ${plain(prompt)}` : undefined,
          gateChangesText(found),
          comments
            ? `${gateCommentsText(boundedComments(comments))}\n(The agent recorded these in your name: its wording.)`
            : undefined,
          NOT_THE_AGENT,
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n\n"),
        note,
      ),
    async apply(content) {
      const decision = content["decision"];
      const reason = text(content["reason"]);
      if (decision !== "approve" && decision !== "reject") {
        return { retry: "choose Approve or Reject." };
      }
      if (decision === "approve" && unverified && content["confirm_unverified"] !== true) {
        return { retry: "approving needs the box ticked: the changes could not be checked." };
      }
      if (decision === "reject" && reason === "" && !comments) {
        return { retry: "a rejection needs a reason." };
      }
      const again = await run.state();
      if (
        !again.active.some(
          (v) => v.node === node && v.phase === "human" && v.attempt === visit.attempt,
        )
      ) {
        return stale("the step is no longer waiting for a decision");
      }
      if (await blockingChange(run, again)) {
        return stale("a change of the pipeline is waiting for you; decide on it first");
      }
      // What is decided is what was shown: files that moved while the dialog was open are new facts.
      // Unless another branch of a fork was active since the gate was reached: it writes to the same
      // tree, so its work would make every gate of the fork undecidable here (the tree is one; a
      // limit recorded in T-40). The host judges that from the journal and says so with a note on
      // the report, so a sibling that arrived at the join while the dialog was open counts too.
      const now = await run.changesSinceGate(node);
      const shared = (report: ChangeReport) =>
        report.kind === "changes" && report.note !== undefined;
      if (!shared(now) && !shared(found) && changesFingerprint(now) !== changesFingerprint(found)) {
        return stale("the files changed while the dialog was open");
      }
      const done = await run.decideHuman(
        node,
        decision === "approve" ? "approved" : "rejected",
        reason === "" ? undefined : reason,
      );
      if (!done.ok) return refusedBy(done);
      return {
        done: "applied",
        said: `${decision === "approve" ? "approved" : "rejected"} the step "${plain(node)}"`,
      };
    },
  };
}

/**
 * `node`: the paused step the answer named. A pause of one branch of a fork leaves the run `running`,
 * so the pause, not the run's status, is what is looked for; and that very branch is what is resumed.
 */
async function pausedQuestion(
  runId: string,
  run: HumanRun,
  node: string,
): Promise<Question | undefined> {
  const state = await run.state();
  if (state.status !== "running" && state.status !== "paused") return undefined;
  const pause = state.pauses.find((p) => p.node === node) ?? state.pauses[0];
  if (!pause) return undefined;
  const why = `${plain(pause.reason)} at ${plain(pause.node)}`;
  const branch =
    pause.fork === undefined ? "" : ` (branch "${plain(pause.fork.branch)}" of a fork)`;
  return {
    key: `${runId}|paused|${why}`,
    notDecided: NOT_DECIDED,
    schema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          title: `Carry the run on at "${plain(pause.node)}", with more attempts for the step that stopped it`,
          default: false,
        },
      },
      required: ["confirm"],
    },
    message: (note) =>
      header(
        runId,
        `the run is paused (${why})${branch}.${
          state.pauses.length > 1
            ? ` It is also paused at: ${state.pauses
                .filter((p) => p !== pause)
                .map((p) => `"${plain(p.node)}"`)
                .join(", ")}; each is resumed on its own.`
            : ""
        }\n\n${NOT_THE_AGENT}`,
        note,
      ),
    async apply(content) {
      if (content["confirm"] !== true) return none("declined", NOT_DECIDED);
      const again = await run.state();
      const still =
        (again.status === "running" || again.status === "paused") &&
        again.pauses.some((p) => p.node === pause.node);
      if (!still) return stale("the run is no longer paused");
      if (await blockingChange(run, again)) {
        return stale("a change of the pipeline is waiting for you; decide on it first");
      }
      const done = await run.resume(pause.node);
      return done.ok ? { done: "applied", said: "resumed the run" } : refusedBy(done);
    },
  };
}

async function changeQuestion(runId: string, run: HumanRun): Promise<Question | undefined> {
  const found = await run.pendingChange();
  // A change the engine refused holds nothing back and cannot be accepted: there is nothing to ask.
  if (!found || found.info.refused !== undefined) return undefined;
  const described = await describePendingChange(run, found);
  return {
    key: `${runId}|change|${found.hash}`,
    notDecided: NOT_DECIDED,
    schema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          title: "Decision",
          enum: ["apply", "discard"],
          enumNames: ["Accept the change", "Drop it"],
        },
        reason: { type: "string", title: "Reason (optional)", maxLength: 2000 },
      },
      required: ["decision"],
    },
    message: (note) =>
      header(
        runId,
        `the pipeline of the run was changed and nothing goes on until you decide.\n\n${described}\n\n${NOT_THE_AGENT}`,
        note,
      ),
    async apply(content) {
      const decision = content["decision"];
      if (decision !== "apply" && decision !== "discard") {
        return { retry: "choose Accept or Drop." };
      }
      // What is decided is what was shown: if the text moved while the dialog was open, nothing is taken.
      const again = await run.pendingChange(undefined, found.info.source);
      if (!again || again.hash !== found.hash) {
        return stale("the change was modified while the dialog was open");
      }
      if (decision === "discard") {
        if (found.info.source === "proposal") {
          if (!(await run.discardProposal())) return stale("there was no proposal left to drop");
        } else {
          const restored = await run.restoreFile();
          return {
            done: "applied",
            said: `dropped the change of the pipeline: ${plain(restored.path)} is back as the run has it`,
          };
        }
        return { done: "applied", said: "dropped the change of the pipeline" };
      }
      const reason = text(content["reason"]);
      const done = await run.acceptChange({
        source: found.info.source,
        text: found.text,
        standing: found.info.standing,
        ...(reason === "" ? {} : { reason }),
      });
      return done.ok
        ? { done: "applied", said: "accepted the change of the pipeline" }
        : refusedBy(done);
    },
  };
}

async function ackQuestion(
  runId: string,
  run: HumanRun,
  why: string,
): Promise<Question | undefined> {
  return {
    key: `${runId}|ack`,
    notDecided: `The person was asked in a dialog and did not accept the state of the run, so your call is still refused. Tell the person, in the language they use, that the state of run ${plain(runId)} was changed outside kodel and that only they can accept it (in a terminal: kodel ack ${plain(runId)}); do not run that command yourself. Then end your turn.`,
    schema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          title: "I looked at what changed and accept the state of the run as it is now",
          default: false,
        },
        note: { type: "string", title: "What you changed (optional)", maxLength: 2000 },
      },
      required: ["confirm"],
    },
    message: (note) =>
      header(
        runId,
        `its state was changed outside kodel: ${plain(why)}\n\nThe agent cannot tell you this is safe. Look at what changed in the run's files (.kodel/runs/${plain(runId)}) before you accept; if you did not change them yourself, decline.`,
        note,
      ),
    async apply(content) {
      if (content["confirm"] !== true) return none("declined", NOT_DECIDED);
      const note = text(content["note"]);
      const done = await run.acknowledge(note === "" ? undefined : note);
      return done.ok ? { done: "applied", said: "accepted the state of the run" } : refusedBy(done);
    },
  };
}
