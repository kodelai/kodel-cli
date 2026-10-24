/**
 * The first handler: it records every session an agent starts in the project, so that whatever reads
 * the history later finds the sessions without scanning the agents' own folders.
 *
 * One line per `SessionStart`, appended with a single write, so two hook processes at once do not
 * tear each other's lines. The same session can be there twice (a resume starts it again); a reader
 * takes the last line of a `session_id`.
 */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { HookHandler } from "@kodel-ai/pipeline-core/hooks";

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
    await appendFile(join(context.root, SESSIONS_INDEX), `${JSON.stringify(record)}\n`);
  },
};
