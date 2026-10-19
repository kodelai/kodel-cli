/**
 * M0 smoke test for the YAML + zod choice. Pipeline files are user-authored, so unknown fields
 * must be rejected (typo detection, fail-closed) and errors must point at a line.
 */
import { expect, test } from "bun:test";
import { isMap, LineCounter, parseDocument } from "yaml";
import { z } from "zod";

const NodeSchema = z.object({ slug: z.string(), retry: z.number().optional() }).strict();

function lineOf(text: string, key: string): number | undefined {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (!isMap(doc.contents)) return undefined;
  for (const pair of doc.contents.items) {
    const k = pair.key as { value?: unknown; range?: [number, number, number] };
    if (k.value === key && k.range) return lineCounter.linePos(k.range[0]).line;
  }
  return undefined;
}

test("parses a valid document", () => {
  const data = NodeSchema.parse(parseDocument("slug: build\nretry: 2\n").toJS());
  expect(data).toEqual({ slug: "build", retry: 2 });
});

test("rejects an unknown field and can report its line", () => {
  const text = "slug: build\nretyr: 2\n";
  const result = NodeSchema.safeParse(parseDocument(text).toJS());
  expect(result.success).toBe(false);
  if (result.success) return;
  const issue = result.error.issues[0];
  expect(issue?.code).toBe("unrecognized_keys");
  const key = (issue as { keys?: string[] }).keys?.[0] ?? "";
  expect(key).toBe("retyr");
  expect(lineOf(text, key)).toBe(2);
});
