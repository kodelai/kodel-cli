/**
 * Reading a JSON Lines file as a stream. The file is never held whole and a line is never held beyond
 * `maxLineBytes` (the logs of agents carry whole prompts and tool outputs in single lines); a line that is
 * too long, or not JSON, is counted and skipped. The last line of a log that is still being written may be
 * torn: it is dropped when it does not parse, and that is not an error.
 */
import { createReadStream } from "node:fs";

export const MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface JsonlCounters {
  lines: number;
  invalid_lines: number;
}

export interface JsonlOptions {
  maxLineBytes?: number;
  /** Read at most this many bytes of the file (a header check). */
  maxBytes?: number;
  counters?: JsonlCounters;
  signal?: AbortSignal;
}

const NEWLINE = 10;

export async function* streamJsonl(
  path: string,
  options: JsonlOptions = {},
): AsyncGenerator<unknown> {
  const cap = options.maxLineBytes ?? MAX_LINE_BYTES;
  const counters = options.counters;
  const stream = createReadStream(path, {
    ...(options.maxBytes === undefined ? {} : { end: options.maxBytes - 1 }),
    highWaterMark: 256 * 1024,
  });
  let parts: Buffer[] = [];
  let size = 0;
  let overflow = false;

  const finish = (torn: boolean): { value: unknown } | undefined => {
    const buffer = Buffer.concat(parts);
    const tooLong = overflow;
    parts = [];
    size = 0;
    overflow = false;
    if (buffer.length === 0 && !tooLong) return undefined;
    if (counters) counters.lines += 1;
    if (tooLong) {
      if (counters) counters.invalid_lines += 1;
      return undefined;
    }
    try {
      return { value: JSON.parse(buffer.toString("utf8")) as unknown };
    } catch {
      if (counters && !torn) counters.invalid_lines += 1;
      return undefined;
    }
  };

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      options.signal?.throwIfAborted();
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(NEWLINE, start);
        const stop = end === -1 ? chunk.length : end;
        if (!overflow) {
          size += stop - start;
          if (size > cap) {
            overflow = true;
            parts = [];
          } else {
            parts.push(chunk.subarray(start, stop));
          }
        }
        if (end === -1) break;
        const parsed = finish(false);
        if (parsed) yield parsed.value;
        start = end + 1;
      }
    }
    const last = finish(true);
    if (last) yield last.value;
  } finally {
    stream.destroy();
  }
}
