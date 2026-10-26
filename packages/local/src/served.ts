/**
 * What the agent was shown at a step, as a file of the run (`served/`): the hash that says whether two
 * answers are the same, the key that says whether one was kept already, and the cut that keeps a file
 * within its limit and still valid JSON. The answer is redacted before any of it is computed, so the
 * hash is the hash of what is stored and a secret cannot survive as half of one.
 */
import { createHash } from "node:crypto";
import { type NextStep, stableJson } from "@kodel-ai/pipeline-core";

/** One file is at most this many bytes. */
export const SERVED_MAX_BYTES = 256 * 1024;

export type ServedNode = Extract<NextStep, { node: unknown }>["node"];

export interface ServedFile {
  v: 1;
  node: string;
  attempt: number;
  n: number;
  prompt_hash: string;
  /** Some of the answer was cut or left out to keep the file within its limit. */
  truncated?: true;
  answer: Record<string, unknown>;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The hash of an answer: the same text always gives the same one; any change of it gives another. */
export function promptHashOf(answer: unknown): string {
  return sha256(stableJson(answer));
}

/**
 * Short, because it is kept in the state, which is rewritten at every step and is not redacted: it
 * never holds the client or the session themselves. Without a client and a session (the run does not
 * record who acts) the answer alone is the key.
 */
export function servedKeyOf(
  promptHash: string,
  client: { name: string; version: string } | undefined,
  session: string | undefined,
): string {
  return sha256(stableJson([promptHash, client?.name, client?.version, session])).slice(0, 16);
}

const size = (file: ServedFile) => Buffer.byteLength(JSON.stringify(file, null, 2));

/** The long texts that are shortened, and the objects that can only be left out. */
const TEXTS: readonly string[][] = [["prompt"], ["reentry_feedback"], ["execution", "instruction"]];
const OBJECTS = ["result_spec", "pipeline_change"] as const;

/** The object that holds the field and the field's name, when the answer has it. */
function at(answer: Record<string, unknown>, path: readonly string[]) {
  const key = path[path.length - 1] as string;
  const holder = path.length === 1 ? answer : answer[path[0] as string];
  return holder !== null && typeof holder === "object"
    ? { holder: holder as Record<string, unknown>, key }
    : undefined;
}

/**
 * The file for an answer, cut when it is over the limit: the biggest field first, so that a huge check
 * does not cost the prompt and a huge prompt does not cost the check. The hash in the file is that of the
 * whole answer. A text is shortened with a marker saying how much went; an object is replaced by one.
 */
export function fitServed(file: ServedFile, max = SERVED_MAX_BYTES): ServedFile {
  if (size(file) <= max) return file;
  const out: ServedFile = { ...file, truncated: true, answer: structuredClone(file.answer) };
  for (let round = 0; round < 8 && size(out) > max; round++) {
    const over = size(out) - max;
    const candidates = [
      ...TEXTS.flatMap((path) => {
        const found = at(out.answer, path);
        const value = found?.holder[found.key];
        return found && typeof value === "string"
          ? [{ length: value.length, ...found, text: true }]
          : [];
      }),
      ...OBJECTS.flatMap((key) =>
        key in out.answer
          ? [
              {
                length: JSON.stringify(out.answer[key]).length,
                holder: out.answer,
                key,
                text: false,
              },
            ]
          : [],
      ),
    ].sort((a, b) => b.length - a.length);
    const biggest = candidates[0];
    if (biggest === undefined || biggest.length === 0) break;
    if (biggest.text) {
      const value = biggest.holder[biggest.key] as string;
      // A character is at least one byte, so dropping `over` characters drops at least that many bytes.
      const keep = Math.max(0, value.length - over - 80);
      biggest.holder[biggest.key] =
        `${value.slice(0, keep)}\n[cut: ${value.length - keep} characters]`;
    } else {
      biggest.holder[biggest.key] = { omitted: true };
    }
  }
  // Whatever is still too big is not a field the engine builds with a size of its own: keep the identity.
  if (size(out) > max) {
    out.answer = { slug: out.answer["slug"], attempt: out.answer["attempt"], omitted: true };
  }
  return out;
}
