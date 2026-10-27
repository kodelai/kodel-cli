/**
 * Which sessions of the agent can belong to a run, and where in each log the run begins. Shared by the copy of the
 * agent's log and by the count of usage, which have different switches: nothing here looks at either.
 *
 * A session belongs to the run when its own log holds a call of the run's tools with the run's id (`findRunStart`).
 * The id of the session comes from the environment of this process and from the hook index; neither is believed
 * without that proof.
 */
import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { cleanExecutorText } from "@kodel-ai/pipeline-core";
import { z } from "zod";
import { SESSION_ENV } from "./executor";
import { claudeConfigDir, findSessionLog } from "./history/claude-code/locate";
import { AGENT_ID } from "./history/claude-code/normalize";
import { findRunStart } from "./history/claude-code/window";
import { isInside, realOrSelf } from "./history/scope";
import { SESSIONS_INDEX } from "./hooks/session-registrar";

/** The newest sessions of the hook index that are looked at. */
const INDEX_SESSIONS = 20;
const INDEX_BYTES = 1024 * 1024;
/** Same shape and length as the run's own id check (`SAFE_ID`): a session the run's account would refuse is refused here. */
export const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A line of the hook index as far as it is used here. */
const INDEX_LINE = z.object({
  session_id: z.string().max(200),
  agent: z.string().max(100),
  transcript_path: z.string().max(4096).optional(),
});

export { claudeConfigDir };

export interface Candidate {
  session: string;
  path: string | undefined;
  /** The log is in the agent's store by name but leads out of it (a link): it is not opened. */
  refused?: true;
}

/** Where the run begins in a log: `null` when the log has no call of this run (yet). */
export interface RunStartMemo {
  path: string;
  start?: { offset: number; ts?: string } | null;
  /** The size of the log when `start` was last looked for, so a log that did not grow is not searched again. */
  searchedSize?: number;
}

/** Whether the log of `memo` has a call of the run, and where the run begins in it; the answer is kept in `memo`. */
export async function proveRunStart(runId: string, memo: RunStartMemo): Promise<boolean> {
  if (memo.start) return true;
  let size: number;
  try {
    size = (await stat(memo.path)).size;
  } catch {
    return false;
  }
  if (memo.start === null && memo.searchedSize === size) return false;
  memo.searchedSize = size;
  memo.start = (await findRunStart(memo.path, runId)) ?? null;
  return memo.start !== null;
}

const TAIL_BYTES = 64;

/** The hash of the 64 bytes of a file that end at `offset`, or `undefined` if the file is shorter. */
export async function sourceTailHash(path: string, offset: number): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    if ((await handle.stat()).size < offset) return undefined;
    const size = Math.min(TAIL_BYTES, offset);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, offset - size);
    return createHash("sha256").update(buffer).digest("hex");
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

export interface SessionFinderOptions {
  /** The project root: where the hook index is, and a place a session of the agent may have started. */
  root: string;
  env: () => NodeJS.ProcessEnv;
}

export class SessionFinder {
  constructor(private readonly options: SessionFinderOptions) {}

  /** Whether the environment or the hook index names a session at all: with none, there is nothing to read. */
  async hasCandidates(): Promise<boolean> {
    const own = cleanExecutorText(this.options.env()[SESSION_ENV]);
    if (own !== undefined && SAFE_SESSION.test(own)) return true;
    return (await this.indexSessions()).size > 0;
  }

  /** The sessions to look at: the environment's, and the newest of the hook index. */
  async candidates(
    env: NodeJS.ProcessEnv,
    configDir: string,
    workdir: string | undefined,
  ): Promise<Candidate[]> {
    const store = join(configDir, "projects");
    const realStore = await realOrSelf(store);
    const dirs = [...(workdir === undefined ? [] : [workdir]), this.options.root];
    const wanted = new Map<string, string | undefined>();
    const own = cleanExecutorText(env[SESSION_ENV]);
    if (own !== undefined && SAFE_SESSION.test(own)) wanted.set(own, undefined);
    for (const [session, transcript] of await this.indexSessions()) {
      if (!wanted.has(session) || wanted.get(session) === undefined)
        wanted.set(session, transcript);
    }
    const found: Candidate[] = [];
    for (const [session, transcript] of wanted) {
      let path: string | undefined;
      // A path from a hook is not trusted to point anywhere but at the agent's own store.
      if (transcript !== undefined && isInside(realStore, await realOrSelf(transcript)))
        path = transcript;
      path ??= await findSessionLog(store, dirs, session);
      // Not even to look for the run in it: a link in the store to a file elsewhere is not a session log.
      if (path !== undefined && !isInside(realStore, await realOrSelf(path))) {
        found.push({ session, path: undefined, refused: true });
        continue;
      }
      found.push({ session, path });
    }
    return found;
  }

  private async indexSessions(): Promise<Map<string, string | undefined>> {
    const out = new Map<string, string | undefined>();
    let text: string;
    try {
      text = await readFile(join(this.options.root, SESSIONS_INDEX), "utf8");
    } catch {
      return out;
    }
    const lines =
      text.length > INDEX_BYTES ? text.slice(-INDEX_BYTES).split("\n").slice(1) : text.split("\n");
    for (const line of lines.reverse()) {
      if (out.size >= INDEX_SESSIONS) break;
      let parsed: ReturnType<typeof INDEX_LINE.safeParse>;
      try {
        parsed = INDEX_LINE.safeParse(JSON.parse(line));
      } catch {
        continue;
      }
      // The index is written by hooks of an agent: only what is plainly a session of this agent is believed.
      if (
        !parsed.success ||
        parsed.data.agent !== AGENT_ID ||
        !SAFE_SESSION.test(parsed.data.session_id)
      ) {
        continue;
      }
      if (!out.has(parsed.data.session_id))
        out.set(parsed.data.session_id, parsed.data.transcript_path);
    }
    return out;
  }
}
