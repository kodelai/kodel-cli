/**
 * Finding the Claude Code sessions of a Kodel project. When the session index of the hook transport
 * (`.kodel/sessions.jsonl`) has lines of this agent, the index is the answer and nothing is scanned. An index
 * with none (the hooks of this agent are not connected, or the file is not there) leaves the scan: the Claude Code
 * folders of the root and of its worktrees are listed, and a log counts only when the `cwd` of its first
 * entry that has one lies in the project: another project's log is opened for that header and no further.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { LocateOptions, SessionRef } from "@kodel-ai/pipeline-core";
import { SESSIONS_INDEX } from "../../hooks/session-registrar";
import { streamJsonl } from "../jsonl";
import { isFile, isInside, isKodelProject, projectWorkdirs, realOrSelf } from "../scope";
import { AGENT_ID } from "./normalize";

/** How much of a log is read to find its `cwd`. */
const HEADER_BYTES = 256 * 1024;
/** Claude Code cuts a folder name at this length and adds a hash after it. */
const NAME_LIMIT = 200;

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
}

/** The folder name Claude Code gives a working directory: every character that is not a letter or digit becomes `-`. */
export const projectFolderName = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

export async function firstCwd(path: string): Promise<string | undefined> {
  for await (const entry of streamJsonl(path, { maxBytes: HEADER_BYTES })) {
    const cwd = (entry as { cwd?: unknown } | null)?.cwd;
    if (typeof cwd === "string" && cwd !== "") return cwd;
  }
  return undefined;
}

/**
 * The agent's folders that can hold sessions of a working directory: its own, and those of the directories under
 * it (a session started in `packages/cli`, or in a run worktree that is gone, has a name that begins with the
 * root's). Only names are listed here; every log is confirmed by its `cwd`. Long names are cut at `NAME_LIMIT`
 * and followed by a hash that is not reproduced, so their first characters are matched.
 */
async function foldersFor(store: string, cwd: string): Promise<string[]> {
  const name = projectFolderName(cwd);
  const prefix = name.length > NAME_LIMIT ? name.slice(0, NAME_LIMIT) : `${name}-`;
  try {
    return (await readdir(store))
      .filter((entry) => entry === name || entry.startsWith(prefix))
      .map((entry) => join(store, entry));
  } catch {
    return [];
  }
}

async function subagentRefs(ref: SessionRef): Promise<SessionRef[]> {
  const dir = join(dirname(ref.path), ref.session_id, "subagents");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
    .sort()
    .map((name) => ({
      agent: AGENT_ID,
      session_id: basename(name, ".jsonl"),
      project_root: ref.project_root,
      path: join(dir, name),
      parent_session_id: ref.session_id,
      ...(ref.cwd === undefined ? {} : { cwd: ref.cwd }),
    }));
}

/** The sessions the index names for this agent, or `undefined` when it has no line of it. */
async function fromIndex(root: string, store: string): Promise<SessionRef[] | undefined> {
  if (!(await isFile(join(root, SESSIONS_INDEX)))) return undefined;
  let named = false;
  const latest = new Map<string, { path: string }>();
  for await (const line of streamJsonl(join(root, SESSIONS_INDEX))) {
    const record = line as Record<string, unknown> | null;
    if (record?.["agent"] !== AGENT_ID || typeof record["session_id"] !== "string") continue;
    named = true;
    const path = record["transcript_path"];
    if (typeof path !== "string") continue;
    latest.set(record["session_id"], { path });
  }
  if (!named) return undefined;
  const refs: SessionRef[] = [];
  const realStore = await realOrSelf(store);
  for (const [session_id, { path }] of latest) {
    // The index is written by an agent's hook; its paths are not trusted to point at the agent's store.
    if (!(await isFile(path)) || !isInside(realStore, await realOrSelf(path))) continue;
    // No cwd from the index: `read` takes it from the log itself.
    refs.push({ agent: AGENT_ID, session_id, project_root: root, path });
  }
  return refs;
}

async function fromScan(root: string, store: string, signal?: AbortSignal): Promise<SessionRef[]> {
  const workdirs = await projectWorkdirs(root);
  const folders = new Set<string>();
  for (const dir of workdirs)
    for (const folder of await foldersFor(store, dir)) folders.add(folder);
  const refs: SessionRef[] = [];
  for (const folder of [...folders].sort()) {
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.endsWith(".jsonl")).sort()) {
      signal?.throwIfAborted();
      const path = join(folder, name);
      const cwd = await firstCwd(path);
      if (cwd === undefined) continue;
      const real = await realOrSelf(cwd);
      if (!workdirs.some((dir) => isInside(dir, real))) continue;
      refs.push({
        agent: AGENT_ID,
        session_id: basename(name, ".jsonl"),
        project_root: root,
        path,
        cwd,
      });
    }
  }
  return refs;
}

export async function locateClaudeSessions(
  root: string,
  store: string,
  options: LocateOptions = {},
): Promise<SessionRef[]> {
  if (!(await isKodelProject(root))) return [];
  const parents = (await fromIndex(root, store)) ?? (await fromScan(root, store, options.signal));
  const refs: SessionRef[] = [];
  for (const parent of parents) {
    refs.push(parent, ...(await subagentRefs(parent)));
  }
  return refs;
}
