/**
 * What a person is shown before they decide something about a run, the same for the terminal
 * (`kodel gate`, `kodel pipeline changes apply`) and for the dialog the coding agent's client shows.
 * Everything here may come from the agent or from files it can write, so it goes through `plain`.
 */
import type { ChangeReport, PendingFound } from "@kodel-ai/local";
import {
  type AttachmentInfo,
  type GateAttachments,
  NOT_SCANNED,
  type PipelineSpec,
} from "@kodel-ai/pipeline-core";
import { formatChange } from "./format";
import { plain } from "./plain";

export const SHOWN_FILES = 10;

/**
 * What the person was shown about the files, as a value to compare with what is true when they
 * answer: the changed files and their lines in a fixed order, and only the kind when the engine
 * could not tell (its wording is not part of the facts).
 */
export function changesFingerprint(found: ChangeReport): string {
  if (found.kind !== "changes") return found.kind;
  return JSON.stringify(
    Object.entries(found.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

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
    // With no file changed yet the note still stands: other branches may write while the person
    // reads. The agent's answer (`changes_note`) follows the same rule.
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

/** A size for a person: bytes, then KB and MB with one decimal. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One attachment as a line: name, type, size, version, and what a person has to know about it (an
 * image was not scanned for secrets; a stored file that is gone or was changed has no content). The
 * name was written by an agent, so it goes through `plain` like everything else here.
 */
export function attachmentLine(info: AttachmentInfo, fresh = false): string {
  const facts = [
    info.type,
    ...(info.lines === undefined ? [] : [`${info.lines} line(s)`]),
    formatBytes(info.bytes),
    `v${info.version}`,
    `by ${plain(info.node)}`,
    ...(info.scanned ? [] : [NOT_SCANNED]),
    ...(info.state === "missing" ? ["THE STORED FILE IS MISSING"] : []),
    ...(info.state === "changed" ? ["THE STORED FILE WAS CHANGED OUTSIDE KODEL"] : []),
    ...(fresh ? ["new since the run stopped here"] : []),
  ];
  return `${plain(info.name)}  ${facts.join(", ")}`;
}

/**
 * The attachments the run keeps, as their own group apart from the project files; nothing when it
 * keeps none. `runId` adds how to read one in a terminal.
 */
export function gateAttachmentsText(
  found: GateAttachments | undefined,
  runId?: string,
): string | undefined {
  if (found === undefined || found.list.length === 0) return undefined;
  const fresh = new Set(found.newSince);
  const shown = found.list
    .slice(0, SHOWN_FILES)
    .map((info) => `  ${attachmentLine(info, fresh.has(info.name))}`);
  const more =
    found.list.length > SHOWN_FILES ? [`  and ${found.list.length - SHOWN_FILES} more`] : [];
  return [
    `${found.list.length} attachment(s) kept with the run (not project files):`,
    ...shown,
    ...more,
    ...(runId === undefined
      ? []
      : [`  read one with: kodel attachment show ${plain(runId)} <name>`]),
  ].join("\n");
}

/** Said when an approval is refused because a version was written after the person looked. */
export const ATTACHMENTS_MOVED = "an attachment was written while you were reading; look again";

/** The comments the agent recorded as the person's: they go back with a rejection, in the agent's wording. */
export function gateCommentsText(comments: { csv: string; count: number }): string {
  const lines = comments.csv.split("\n").map((line) => `  ${plain(line)}`);
  return `${comments.count} comment(s) recorded at this step will go back with the rejection:\n${lines.join("\n")}`;
}
