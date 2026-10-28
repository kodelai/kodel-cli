/**
 * Where a run begins in a Claude Code log. A session belongs to a run when it called one of the run's tools
 * with the run's id: the id is in the input of `pipeline_next_step` and `pipeline_complete_step`, and in the
 * result of `pipeline_start` (which has no run yet in its input). The window starts at the first such call, so
 * what the person and the agent said before it, and what an earlier run did in the same session, stay out.
 * The search looks at lines, not at events, so it works whatever the capture mode and stores nothing.
 */
import { toTs } from "@kodel-ai/pipeline-core";
import { streamRawLines } from "../jsonl";

/** A tool of the pipeline server, whatever the server is called in `.mcp.json`. */
const PIPELINE_TOOL = /(?:^|__)pipeline_(?:start|next_step|complete_step)$/;

/** Calls waiting for their result; a run's id is looked for in the result of only these. */
const CALLS_CAP = 1_000;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      isObject(block) && typeof block["text"] === "string" ? (block["text"] as string) : "",
    )
    .join("\n");
}

function at(start: number, entry: Json): RunStart {
  const ts = toTs(entry["timestamp"]);
  return { offset: start, ...(ts === undefined ? {} : { ts }) };
}

export interface RunStart {
  /** The byte the line of the first call starts at. */
  offset: number;
  /** The time of that call, when the line has one. */
  ts?: string;
}

/** The start of the run in the log, or `undefined` when the session never called the run's tools with its id. */
export async function findRunStart(
  path: string,
  runId: string,
  signal?: AbortSignal,
): Promise<RunStart | undefined> {
  const calls = new Map<string, { start: number; ts: string | undefined }>();
  for await (const { text, start } of streamRawLines(path, signal ? { signal } : {})) {
    const mentionsRun = text.includes(runId);
    const mayCall = text.includes("tool_use") && text.includes("pipeline_");
    if (!mentionsRun && !mayCall) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isObject(entry) || !isObject(entry["message"])) continue;
    const content = entry["message"]["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block["type"] === "tool_use") {
        const id = block["id"];
        const name = block["name"];
        if (typeof id !== "string" || typeof name !== "string" || !PIPELINE_TOOL.test(name))
          continue;
        if ((JSON.stringify(block["input"]) ?? "").includes(runId)) return at(start, entry);
        if (calls.size >= CALLS_CAP) {
          const oldest = calls.keys().next().value;
          if (oldest !== undefined) calls.delete(oldest);
        }
        calls.set(id, { start, ts: toTs(entry["timestamp"]) });
      } else if (block["type"] === "tool_result") {
        const id = block["tool_use_id"];
        const call = typeof id === "string" ? calls.get(id) : undefined;
        if (call !== undefined && resultText(block["content"]).includes(runId)) {
          return { offset: call.start, ...(call.ts === undefined ? {} : { ts: call.ts }) };
        }
      }
    }
  }
  return undefined;
}
