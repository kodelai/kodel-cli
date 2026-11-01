import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  AGENT_LOG_FAILURES,
  DEFAULT_AGENT_LOG,
  DEFAULT_USAGE,
  HISTORY_CATEGORIES,
  USAGE_FAILURES,
} from "@kodel-ai/pipeline-core";
import { parse } from "yaml";
import { HISTORY_SECTION_KEYS } from "../src";

const DOCS = fileURLToPath(new URL("../../../docs/history.md", import.meta.url));
const CONFIG_SOURCE = fileURLToPath(new URL("../src/config.ts", import.meta.url));
const read = () => readFile(DOCS, "utf8");

/** The part of the page about the agent log, up to the next section. */
async function section(): Promise<string> {
  const text = await read();
  const start = text.indexOf("## The agent log (`agent_log/`)");
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf("\n## ", start + 10);
  return text.slice(start, end === -1 ? undefined : end);
}

describe("t3bk2 the page about the agent log", () => {
  test("t3bk2_docs_text", async () => {
    // the page wraps its lines where it likes: what is looked for is the words
    const text = (await read()).replace(/\s+/g, " ");
    const agentLog = (await section()).replace(/\s+/g, " ");
    // what was planned is built: the page no longer says it is not
    expect(text).not.toContain("are built in TASK-3BK2");
    expect(text).not.toContain("no `agent_log/` in a run");
    expect(text).not.toContain("exact, since the agent starts a server per session");
    // the changes of the decisions are told where a reader meets them
    expect(agentLog).toContain("Projects that upgrade start storing full sessions");
    expect(agentLog).toContain(
      'the decision said "from the response that issued `pipeline_start`"',
    );
    expect(agentLog).toContain("after `/clear` the environment names the old session");
    expect(agentLog).toContain("`session_unknown`");
    expect(agentLog).toContain("loses at most one interval and the open response");
    expect(agentLog).toContain("ended in the middle of a step");
    expect(agentLog).toContain("the timer cannot spend the share of the next step");
    expect(agentLog).toContain("*what the agent has flushed*");
    expect(agentLog).toContain("drops only bytes nothing vouched for, so no history is rewritten");
    expect(agentLog).toContain("`.kodel/runs/*/agent_log`");
    expect(agentLog).toContain("`interval_s`");
    expect(agentLog).toContain("An agent that starts its own `kodel mcp`");
    expect(agentLog).toContain(
      "sample run in `fixtures/agent-log/` is moved under the frozen formats",
    );
    // the page says `unverified` and never calls a stored stream modified
    expect(agentLog).toContain("shown as `unverified`");
    expect(agentLog).toContain('never "modified"');
    for (const reason of AGENT_LOG_FAILURES) expect(agentLog).toContain(`\`${reason}\``);
  });

  test("t3bk2_docs_defaults_match", async () => {
    const agentLog = await section();
    const block = /```yaml\n([\s\S]*?)```/.exec(agentLog)?.[1] ?? "";
    const documented = parse(block) as { history: { agent_log: Record<string, unknown> } };
    const shown = documented.history.agent_log;
    expect(shown["enabled"]).toBe(DEFAULT_AGENT_LOG.enabled);
    expect(shown["mode"]).toBe(DEFAULT_AGENT_LOG.mode);
    expect(shown["max_kb"]).toBe(DEFAULT_AGENT_LOG.max_kb);
    expect(shown["interval_s"]).toBe(DEFAULT_AGENT_LOG.interval_s);
    // the caps of the table are the defaults of the kinds
    const rows = [...agentLog.matchAll(/^\| [^|]+ \| `(\w+)` \| ([\d ]+) \|/gm)];
    expect(rows.map((m) => m[1])).toEqual(["user", "agent", "tool_input", "tool_result"]);
    for (const [, key, cap] of rows) {
      const kind = key as keyof typeof DEFAULT_AGENT_LOG.preview_chars;
      expect(Number((cap as string).replaceAll(" ", ""))).toBe(
        DEFAULT_AGENT_LOG.preview_chars[kind],
      );
    }
    // the example's single number is a cap the config accepts for every kind
    expect(shown["preview_chars"]).toBe(DEFAULT_AGENT_LOG.preview_chars.user);
  });

  test("t3bk2_history_keys_exact", async () => {
    // the sections of `history` the config reads: the categories with a switch, and the one with more keys
    expect([...HISTORY_SECTION_KEYS].sort()).toEqual(
      [...HISTORY_CATEGORIES, "agent_log", "usage"].sort(),
    );
    // and the comment that tells which are which says so
    const source = await readFile(
      fileURLToPath(new URL("../../pipeline-core/src/history-config.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain(
      "The agent's conversation log (`agent_log`) is the most sensitive one",
    );
    expect(CONFIG_SOURCE).toContain("config.ts");
  });
});

/** The part of the page about usage and cost, up to the next section. */
async function usageSection(): Promise<string> {
  const text = await read();
  const start = text.indexOf("## Usage and cost (`usage_recorded`)");
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf("\n## ", start + 10);
  return text.slice(start, end === -1 ? undefined : end);
}

describe("t9jrs the page about usage and cost", () => {
  test("t9jrs_docs_history_updated", async () => {
    const text = (await read()).replace(/\s+/g, " ");
    // what was planned is built: the page no longer says it is not, nor that a release waits for it
    expect(text).not.toContain("Prices (planned)");
    expect(text).not.toContain("not yet built");
    expect(text).not.toContain("so the release waits for it");
    const usage = (await usageSection()).replace(/\s+/g, " ");
    expect(usage).toContain("`agent_log: false` does not stop the transcript being read");
    expect(usage).toContain("only `usage: false` does");
    expect(usage).toContain("Every cost is an estimate");
    expect(usage).toContain(
      "is not an event, is never in a run and is never shown as a run's cost",
    );
    expect(usage).toContain("a total over it is `partial`, never `$0`");
    expect(usage).toContain("not a bill");
    for (const reason of USAGE_FAILURES) expect(usage).toContain(`\`${reason}\``);
  });

  test("t9jrs_docs_usage_defaults_match", async () => {
    const block = /```yaml\n([\s\S]*?)```/.exec(await usageSection())?.[1] ?? "";
    const documented = parse(block) as { history: { usage: Record<string, unknown> } };
    expect(documented.history.usage["enabled"]).toBe(DEFAULT_USAGE.enabled);
  });
});
