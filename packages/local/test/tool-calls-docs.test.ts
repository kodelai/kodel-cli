import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_TOOL_CALLS, TOOL_CALLS_FAILURES } from "@kodel-ai/pipeline-core";
import { parse } from "yaml";

const HISTORY = fileURLToPath(new URL("../../../docs/history.md", import.meta.url));
const FORMATS = fileURLToPath(new URL("../../../docs/run-formats.md", import.meta.url));

async function section(): Promise<string> {
  const text = await readFile(HISTORY, "utf8");
  const start = text.indexOf("## Tool calls (`tool_calls_recorded`)");
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf("\n## ", start + 10);
  return text.slice(start, end === -1 ? undefined : end);
}

describe("zkrh the page about tool calls", () => {
  test("zkrh_docs_history_section_tool_calls", async () => {
    const text = (await section()).replace(/\s+/g, " ");
    // information only, and not verified
    expect(text).toContain("it is information only");
    expect(text).toContain("`unverified`");
    // what is never recorded and what a preview costs, said where a person looks
    expect(text).toContain("What is never recorded");
    expect(text).toContain("the final response of the last agent step");
    expect(text).toContain("Previews are in the journal");
    expect(text).toContain("set `preview_chars: 0` there");
    expect(text).toContain("`history.tool_log` is the switch of the hooks");
    expect(text).toContain("says nothing of whether its step passed");
    expect(text).toContain("because `history` is strict");
    // the way the attempt of a call is told, and the limits
    expect(text).toContain("usage's rule, placed by time");
    expect(text).toContain("marked `shared`");
    expect(text).toContain("over 8 MB");
    // every reason the record can give for not recording is named
    for (const reason of TOOL_CALLS_FAILURES) expect(text).toContain(`\`${reason}\``);
  });

  test("zkrh_docs_tool_calls_defaults_match", async () => {
    const block = /```yaml\n([\s\S]*?)```/.exec(await section())?.[1] ?? "";
    const documented = parse(block) as { history: { tool_calls: Record<string, unknown> } };
    expect(documented.history.tool_calls["enabled"]).toBe(DEFAULT_TOOL_CALLS.enabled);
    expect(documented.history.tool_calls["preview_chars"]).toBe(DEFAULT_TOOL_CALLS.preview_chars);
  });

  test("zkrh_run_formats_says_what_a_run_in_flight_does", async () => {
    const text = (await readFile(FORMATS, "utf8")).replace(/\s+/g, " ");
    expect(text).toContain("## Tool calls (TASK-ZKRH)");
    expect(text).toContain("reads `not_captured` and goes on as before");
    expect(text).toContain("Nothing here needs `kodel migrate`");
  });
});
