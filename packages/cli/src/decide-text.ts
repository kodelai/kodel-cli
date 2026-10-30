/**
 * What a person is shown before they decide something about a run, the same for the terminal
 * (`kodel gate`, `kodel pipeline changes apply`) and for the dialog the coding agent's client shows.
 * Everything here may come from the agent or from files it can write, so it goes through `plain`.
 */
import type { ChangeReport, PendingFound } from "@kodel-ai/local";
import type { PipelineSpec } from "@kodel-ai/pipeline-core";
import { formatChange } from "./format";
import { plain } from "./plain";

export const SHOWN_FILES = 10;

/**
 * Said under a gate's list of changes when other branches of a fork were active since the step was
 * reached (the host's `note`): the tree is one, so whose write is whose cannot be told (T-40).
 */
export const SHARED_TREE_TEXT =
  "Other branches were running while this step waited: some of these files may be theirs; the changes cannot be told apart in one working tree.";

/** A change of the run's pipeline that waits, as the person reads it: where it came from, then what differs. */
export async function describePendingChange(
  run: { currentSpec(): Promise<PipelineSpec> },
  found: PendingFound,
): Promise<string> {
  const { info } = found;
  const current = await run.currentSpec();
  const origin =
    info.source === "proposal"
      ? "The agent proposed another version of the pipeline."
      : `The pipeline file ${plain(info.watched ?? "")} was changed.`;
  const body = formatChange(current, found.spec, info.changes, info.redo, plain);
  return info.refused === undefined
    ? `${origin}\n\n${body}`
    : `${origin}\n\nIt cannot be accepted: ${plain(info.refused)}\n\n${body}`;
}

/**
 * What changed in the files since the run stopped at the step. What the agent did after the run
 * stopped here is not what the checks saw. When that cannot be told (the record is gone, or git
 * fails: something an agent could make happen), it is said so; "nothing changed" is never written.
 * Nothing when the engine compared the files and found no difference.
 */
export function gateChangesText(found: ChangeReport): string | undefined {
  if (found.kind === "changes") {
    const files = Object.keys(found.files);
    // With no file changed yet the note still stands: other branches may write while the person reads.
    const shared = found.note === undefined ? [] : [SHARED_TREE_TEXT];
    if (files.length === 0) return shared[0];
    const shown = files.slice(0, SHOWN_FILES).map((f) => `  ${plain(f)}`);
    const more = files.length > SHOWN_FILES ? [`  and ${files.length - SHOWN_FILES} more`] : [];
    return [
      `${files.length} file(s) changed since the run stopped here:`,
      ...shown,
      ...more,
      ...shared,
    ].join("\n");
  }
  if (found.kind === "unavailable") {
    return `WARNING: the engine cannot tell what changed since the run stopped here: ${plain(found.reason)}\nThe agent may have gone on working after its checks passed.`;
  }
  return undefined;
}

/** The comments the agent recorded as the person's: they go back with a rejection, in the agent's wording. */
export function gateCommentsText(comments: { csv: string; count: number }): string {
  const lines = comments.csv.split("\n").map((line) => `  ${plain(line)}`);
  return `${comments.count} comment(s) recorded at this step will go back with the rejection:\n${lines.join("\n")}`;
}
