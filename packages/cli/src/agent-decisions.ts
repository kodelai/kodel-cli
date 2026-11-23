/**
 * The agent deciding for a person, in the two cases a project's config allows (`decisions.agent`):
 * a gate and a change of a run's pipeline. It does what the person's command or dialog does, with
 * the same checks, and the journal says the agent did it, with the words it was given. The engine
 * cannot tell whether the person said so; that is what the config switch is for. `ack`, `resume`
 * and `seal` are not here and cannot be added by a flag.
 */
import {
  type AgentDecision,
  attachmentAnswer,
  failure,
  type PipelineService,
  type ToolResult,
} from "@kodel-ai/pipeline-core";
import type { AgentDecider } from "@kodel-ai/pipeline-core/mcp";
import { blockingChange, type DialogState, type HumanHost, type HumanRun } from "./elicit";
import { plain } from "./plain";

const WHILE_DIALOG =
  "The person has a dialog open and may be answering it. Nothing was decided. Do not decide it yourself; end your turn and call pipeline_next_step when they have answered.";

/** The answer while a dialog is open; it reads like the other `waiting` answers. */
const dialogOpen = (): ToolResult => ({
  ok: true,
  waiting: { reason: "dialog_open", message: WHILE_DIALOG, tell_the_person: WHILE_DIALOG },
});

/**
 * An agent decides only on a run of its own checkout. A person may decide on behalf of another
 * clone's run (the command says whose it is); an agent that was told to approve is not given that.
 */
async function foreignRefusal(run: HumanRun, runId: string): Promise<ToolResult | undefined> {
  const root = await run.foreignRoot?.();
  return root === undefined
    ? undefined
    : failure(
        "WORKDIR_INVALID",
        `run ${plain(runId)} belongs to the checkout at ${plain(root)}; it is decided from there, not from this one`,
      );
}

/** The run as it is after the decision, with the mark that the agent made it. */
async function after(
  service: PipelineService,
  runId: string,
  what: Record<string, unknown>,
): Promise<ToolResult> {
  const fresh = await service.nextStep({ run_id: runId }).catch(() => undefined);
  if (!fresh?.ok) return { ok: true, decided_by: "agent", ...what };
  const { ok: _ok, ...next } = fresh;
  return { ok: true, decided_by: "agent", ...what, next };
}

export function createAgentDecider(humans: HumanHost, dialog: DialogState): AgentDecider {
  return {
    async decideGate(service, input) {
      if (dialog.open > 0) return dialogOpen();
      const run = await humans.open(input.run_id);
      if (!run) return failure("UNKNOWN_RUN", `there is no run ${plain(input.run_id)}`);
      const foreign = await foreignRefusal(run, input.run_id);
      if (foreign) return foreign;
      const node = input.node_slug;
      const state = await run.state();
      const visit = state.active.find((v) => v.node === node && v.phase === "human");
      if (!visit) {
        return failure(
          "NODE_NOT_RUNNING",
          `the run is not waiting for a decision at "${plain(node)}"`,
        );
      }
      if (visit.attempt !== input.attempt) {
        return failure(
          "ATTEMPT_MISMATCH",
          `the step is at attempt ${visit.attempt}, not ${input.attempt}; look at the run again with pipeline_next_step`,
        );
      }
      if (await blockingChange(run, state)) {
        return failure(
          "PIPELINE_CHANGE_REFUSED",
          "a change of the pipeline is waiting for the person and holds the run; it has to be decided first",
        );
      }
      const approved = input.decision === "approved";
      if (
        approved &&
        input.confirm_unverified !== true &&
        (await run.changesSinceGate(node)).kind === "unavailable"
      ) {
        return failure(
          "INVALID_ARGUMENTS",
          "the engine could not tell what changed since the step was reached; approving needs confirm_unverified: true, and only if the person said to approve anyway",
        );
      }
      // What is approved is what the person was told about: the attachments of the waiting answer
      // the agent passed on. A missing fingerprint, or one from before a version was written, is
      // refused with the answer as it is now, so the agent tells the person what is new.
      let seen: { attachments: string | undefined } | undefined;
      if (approved && run.gateAttachments) {
        const now = await run.gateAttachments(node);
        // What the decision is held against once more, under the run's lock.
        seen = { attachments: now.fingerprint };
        if (now.fingerprint !== undefined && input.attachments_fingerprint !== now.fingerprint) {
          const fresh = await service.nextStep({ run_id: input.run_id }).catch(() => undefined);
          const { ok: _ok, ...next } = fresh?.ok ? fresh : { ok: true };
          const newSince = new Set(now.newSince);
          return failure(
            "INVALID_ARGUMENTS",
            input.attachments_fingerprint === undefined
              ? "the run keeps attachments: approving needs attachments_fingerprint, the one of the answer the person decided on (details has it as it is now, with the attachments it stands for); tell the person about the attachments first"
              : "an attachment was written since the answer the person decided on; tell them what is new (details has the attachments as they are now) and decide again only if they say so",
            undefined,
            {
              // Also here, not only in `next`: with a sibling step open the answer is that step,
              // which lists no attachments.
              attachments_fingerprint: now.fingerprint,
              attachments: now.list.map((info) => ({
                ...attachmentAnswer(info),
                ...(newSince.has(info.name) ? { new: true } : {}),
              })),
              next,
            },
          );
        }
      }
      const reason = input.reason?.trim() ?? "";
      if (!approved && reason === "" && !(await run.gateResults(node))) {
        return failure("INVALID_ARGUMENTS", "a rejection needs a reason");
      }
      const by: AgentDecision = { instruction: input.instruction };
      // A dialog may have opened while the checks above ran; the person's form comes first. Looking
      // and claiming happen in one tick, so a dialog that starts later is skipped, not shown twice.
      if (dialog.open > 0) return dialogOpen();
      dialog.deciding++;
      let done: Awaited<ReturnType<typeof run.decideHuman>>;
      try {
        done = await run.decideHuman(
          node,
          input.decision,
          reason === "" ? undefined : reason,
          by,
          seen,
        );
      } finally {
        dialog.deciding--;
      }
      if (!done.ok) return failure(done.error.code, done.error.message);
      return after(service, input.run_id, { decision: input.decision, node_slug: node });
    },

    async acceptChange(service, input) {
      if (dialog.open > 0) return dialogOpen();
      const run = await humans.open(input.run_id);
      if (!run) return failure("UNKNOWN_RUN", `there is no run ${plain(input.run_id)}`);
      const foreign = await foreignRefusal(run, input.run_id);
      if (foreign) return foreign;
      const found = await run.pendingChange();
      if (!found) {
        return failure("PIPELINE_CHANGE_REFUSED", "no change of this run's pipeline is waiting");
      }
      if (found.hash !== input.change_hash) {
        return failure(
          "INVALID_ARGUMENTS",
          "change_hash is not the change that waits now; look at the run again with pipeline_next_step and tell the person what it changes",
        );
      }
      if (found.info.refused !== undefined) {
        return failure(
          "PIPELINE_CHANGE_REFUSED",
          `the engine cannot take this change: ${plain(found.info.refused)}`,
        );
      }
      const reason = input.reason?.trim() ?? "";
      if (dialog.open > 0) return dialogOpen();
      dialog.deciding++;
      let done: Awaited<ReturnType<typeof run.acceptChange>>;
      try {
        done = await run.acceptChange({
          source: found.info.source,
          text: found.text,
          standing: found.info.standing,
          ...(reason === "" ? {} : { reason }),
          byAgent: { instruction: input.instruction },
        });
      } finally {
        dialog.deciding--;
      }
      if (!done.ok) return failure(done.error.code, done.error.message);
      return after(service, input.run_id, { accepted: found.hash });
    },
  };
}
