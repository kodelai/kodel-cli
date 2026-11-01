/**
 * The first handler: it records every session an agent starts in the project, so that whatever reads
 * the history later finds the sessions without scanning the agents' own folders.
 *
 * One line per `SessionStart`, appended with a single write, so two hook processes at once do not
 * tear each other's lines. The same session can be there twice (a resume starts it again); a reader
 * takes the last line of a `session_id`.
 *
 * The file is in the project (`.kodel/sessions.jsonl`) or, with `storage: home`, in the project's
 * folder under `~/.kodel`. The hook reads that setting with a line matcher (it has no time to load the
 * config); a place it cannot use is a failure that goes to `.kodel/hooks.log`, and nothing is written.
 */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { HookHandler } from "@kodel-ai/pipeline-core/hooks";
import { ensurePlace, placeOfRoot, scrubHome } from "../storage-paths";

export const SESSIONS_INDEX = join(".kodel", "sessions.jsonl");

export interface SessionRecord {
  session_id: string;
  agent: string;
  transcript_path?: string;
  cwd: string;
  ts: string;
}

export const sessionRegistrar: HookHandler = {
  id: "session-registrar",
  events: ["SessionStart"],
  async run(event, context) {
    const record: SessionRecord = {
      session_id: event.session_id,
      agent: event.agent,
      ...(event.transcript_path === undefined ? {} : { transcript_path: event.transcript_path }),
      cwd: event.cwd,
      ts: event.ts,
    };
    const place = await placeOfRoot(context.root);
    try {
      // Only the project's own folder: the hook must not leave the folders of runs and proposals behind.
      await ensurePlace(place, "tree");
      await appendFile(place.sessionsPath, `${JSON.stringify(record)}\n`);
    } catch (error) {
      // The failure goes to `.kodel/hooks.log` in the project: without the home folder in it.
      throw new Error(scrubHome(error instanceof Error ? error.message : String(error), place));
    }
  },
};
