/**
 * The attachments of a run on the card (T-45): which version is looked at, where a comment about one
 * is about, and how a comment's place is told from a project path. Pure; the card's tabs and keys use it.
 */
import {
  type AttachmentLocation,
  formatAttachmentLocation,
  parseAttachmentLocation,
} from "@kodel-ai/pipeline-core";
import type { DiffRow } from "./diffview";
import type { AttachmentVersionView, AttachmentView, Comment, GateDetail } from "./session";

/**
 * The start of the key a version's diff is read and kept under. A path of a project file is relative
 * and never starts with a slash, so a file named `attachment:...` cannot be taken for a version.
 */
export const ATTACHMENT_KEY = "/attachment:";

export const attachmentKey = (name: string, version: number): string =>
  `/${formatAttachmentLocation({ name, version })}`;

export function parseAttachmentKey(key: string): { name: string; version: number } | undefined {
  if (!key.startsWith(ATTACHMENT_KEY)) return undefined;
  const at = parseAttachmentLocation(key.slice(1));
  return at === undefined || at.line !== undefined
    ? undefined
    : { name: at.name, version: at.version };
}

/**
 * A project path as the place of a comment. One that starts with `attachment:` is written
 * `./attachment:...`, so it can never read as a version of an attachment.
 */
export const projectPlace = (path: string): string =>
  path.startsWith("attachment:") ? `./${path}` : path;

/** The attachment a location points at: only if it has the form and the run has that name. */
export function attachmentOf(
  d: Pick<GateDetail, "attachments">,
  location: string,
): AttachmentLocation | undefined {
  const at = parseAttachmentLocation(location);
  return at !== undefined && d.attachments?.some((a) => a.name === at.name) ? at : undefined;
}

/** The version the person looks at: the one picked with `[` and `]`, or the latest. */
export function versionAt(
  view: AttachmentView,
  version: number | undefined,
): AttachmentVersionView | undefined {
  return view.versions.find((v) => v.version === version) ?? view.versions.at(-1);
}

/** The version `by` places from the one looked at; it stops at the first and the last. */
export function stepVersion(view: AttachmentView, version: number | undefined, by: 1 | -1): number {
  const at = view.versions.findIndex((v) => v.version === versionAt(view, version)?.version);
  const next = view.versions[Math.min(view.versions.length - 1, Math.max(0, at + by))];
  return next?.version ?? version ?? 1;
}

/**
 * Where a comment about a version is about: the version itself (an image, or no line picked), a line
 * of it, or, for a line the version removed, that line of the version before.
 */
export function attachmentPlace(
  view: AttachmentView,
  version: AttachmentVersionView,
  row?: DiffRow,
): string {
  if (row === undefined)
    return formatAttachmentLocation({ name: view.name, version: version.version });
  if (row.kind === "del") {
    const before = view.versions[view.versions.findIndex((v) => v.version === version.version) - 1];
    if (before !== undefined && row.old !== undefined) {
      return formatAttachmentLocation({ name: view.name, version: before.version, line: row.old });
    }
  }
  return formatAttachmentLocation({
    name: view.name,
    version: version.version,
    ...(row.new === undefined ? {} : { line: row.new }),
  });
}

/** How many comments are about a project file: by its place, never one that points at an attachment. */
export function fileCommentCount(d: GateDetail, path: string): number {
  const place = projectPlace(path);
  return d.comments.filter(
    (c) =>
      (c.location === place || c.location.startsWith(`${place}:`)) &&
      attachmentOf(d, c.location) === undefined,
  ).length;
}

/** How many comments are about an attachment, whatever version or line they name. */
export function attachmentCommentCount(d: GateDetail, name: string): number {
  return d.comments.filter((c) => attachmentOf(d, c.location)?.name === name).length;
}

/**
 * What is drawn under the lines of a version: the person's comments, and the findings of the steps
 * that point at an attachment (a critique of a plan names its lines this way).
 */
export function notesOnAttachments(d: GateDetail): Comment[] {
  const findings = d.visits.flatMap((visit) =>
    visit.human ? [] : (visit.attempt.review?.findings ?? []),
  );
  return [...d.comments, ...findings.filter((f) => attachmentOf(d, f.location) !== undefined)];
}
