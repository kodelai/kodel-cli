/**
 * The history tools over a real store: the golden runs of `fixtures/` are read through `LocalPipelineHost` and the
 * tools of `@kodel-ai/pipeline-core/mcp`, with nothing written, whatever shape the run is in.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PipelineService } from "@kodel-ai/pipeline-core";
import { invokeHistoryTool } from "@kodel-ai/pipeline-core/mcp";
import { LocalPipelineHost } from "../src";

// biome-ignore lint/suspicious/noExplicitAny: the answers are read as loose JSON, each test names what it checks
type Loose = any;

const FIXTURES = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "fixtures");
const DEV = "r_0mvu1vxry_4ggv"; // format 2, finished, several attempts, gates
const DEV_OTHER = "r_0mvu1w1ng_dk6c"; // format 2, finished
const V1 = ["r_0mviewgvl_i1ig", "r_0mvimyn54_tc9o"]; // format 1, finished
const LOG_RUN = "r_0mvqeq4tq_fsjv"; // format 1, two nodes, a main session and a subagent's

let tmp: string;
let root: string;
let host: LocalPipelineHost;
let service: PipelineService;

const runsDir = () => join(root, ".kodel", "runs");
const call = (name: string, args: Record<string, unknown>) =>
  invokeHistoryTool(service, name, args) as Promise<Record<string, Loose>>;

async function put(from: string, id: string) {
  await cp(join(FIXTURES, from, id), join(runsDir(), id), { recursive: true });
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "kodel-history-tools-"));
  root = join(tmp, "project");
  await mkdir(runsDir(), { recursive: true });
  for (const id of [DEV, DEV_OTHER]) await put("formats/v2", id);
  for (const id of V1) await put("formats/v1", id);
  await put("agent-log", LOG_RUN);
  host = new LocalPipelineHost({ root, heartbeatMs: 0, integrityDir: join(tmp, "integrity") });
  service = new PipelineService(host);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Every file under `dir` with its bytes and modification time: what "nothing was written" means. */
async function snapshot(dir: string, base = dir): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(found, await snapshot(path, base));
    else {
      const info = await stat(path);
      found[path.slice(base.length)] =
        `${info.mtimeMs}:${(await readFile(path)).toString("base64")}`;
    }
  }
  return found;
}

describe("history_runs over a store", () => {
  test("history_tools_runs_lists_the_runs_of_the_store", async () => {
    const answer = await call("history_runs", { limit: 100 });
    expect(answer.page.total).toBe(5);
    const ids = answer.runs.map((r: Loose) => r.run_id).sort();
    expect(ids).toEqual([DEV, DEV_OTHER, LOG_RUN, ...V1].sort());
    const dev = answer.runs.find((r: Loose) => r.run_id === DEV);
    expect(dev).toMatchObject({ pipeline: "dev", status: "completed" });
    expect(dev.slug.length).toBeGreaterThan(0);
    expect(JSON.stringify(answer)).not.toContain('"task"');
    const times = answer.runs.map((r: Loose) => Date.parse(r.started_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  test("history_tools_runs_pages_over_a_store", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const answer = await call("history_runs", { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...answer.runs.map((r: Loose) => r.run_id));
      cursor = answer.page.next;
    } while (cursor);
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
  });

  test("history_tools_unreadable_runs_keep_their_own_error", async () => {
    const newer = join(runsDir(), DEV_OTHER, "state.json");
    const state = JSON.parse(await readFile(newer, "utf8"));
    await writeFile(newer, JSON.stringify({ ...state, v: 99 }));
    const broken = join(runsDir(), DEV, "state.json");
    await writeFile(broken, "{ not json");

    const list = await call("history_runs", { limit: 100 });
    const newerRow = list.runs.find((r: Loose) => r.run_id === DEV_OTHER);
    expect(newerRow).toMatchObject({
      status: "format 99",
      unreadable: { code: "UNSUPPORTED_FORMAT", format: 99 },
    });
    const brokenRow = list.runs.find((r: Loose) => r.run_id === DEV);
    expect(brokenRow.status).toBe("unreadable");
    expect(brokenRow.unreadable.code).not.toBe("UNSUPPORTED_FORMAT");
    // an unreadable run still matches a status filter by the string the list shows, and counts
    const filtered = await call("history_runs", { status: "format 99" });
    expect(filtered.page.total).toBe(1);

    const refused = await call("history_run_details", { run_id: DEV_OTHER });
    expect(refused).toMatchObject({ ok: false, code: "UNSUPPORTED_FORMAT" });
    const damaged = await call("history_run_details", { run_id: DEV });
    expect(damaged.ok).toBe(false);
    expect(damaged.code).toBe(brokenRow.unreadable.code);
  });
});

describe("history_run_details over a store", () => {
  test("history_tools_details_levels_over_a_finished_run", async () => {
    const run = await call("history_run_details", { run_id: DEV, limit: 100 });
    expect(run).toMatchObject({ ok: true, level: "run", run: { status: "completed", format: 2 } });
    expect(run.integrity.seal).toMatch(/^(sealed|modified|unsealed|open)$/);
    expect(run.integrity.files).toMatch(/^(ok|modified|unknown)$/);
    const names = run.nodes.map((n: Loose) => n.node);
    expect(names).toContain("publish");
    const critique = run.nodes.find((n: Loose) => n.node === "plan-critique");
    expect(critique.attempts).toBe(3);

    const node = await call("history_run_details", {
      run_id: DEV,
      node: "plan-critique",
      limit: 2,
    });
    expect(node.node).toMatchObject({ node: "plan-critique", attempts: 3 });
    expect(node.attempts.map((a: Loose) => a.attempt)).toEqual([1, 2]);
    const rest = await call("history_run_details", {
      run_id: DEV,
      node: "plan-critique",
      limit: 2,
      cursor: node.page.next,
    });
    expect(rest.attempts.map((a: Loose) => a.attempt)).toEqual([3]);

    const attempt = await call("history_run_details", {
      run_id: DEV,
      node: "plan-critique",
      attempt: 3,
    });
    expect(attempt).toMatchObject({ ok: true, level: "attempt" });
    expect(attempt.attempt.attempt).toBe(3);
    // the run was made without tool calls recorded: the block says so
    expect(attempt.tool_calls.not_collected ?? attempt.tool_calls.unverified).toBeDefined();
  });

  test("history_tools_pagination_walks_every_node_once", async () => {
    const all = await call("history_run_details", { run_id: DEV, limit: 200 });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const answer = await call("history_run_details", {
        run_id: DEV,
        limit: 4,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...answer.nodes.map((n: Loose) => n.node));
      cursor = answer.page.next;
    } while (cursor);
    expect(seen).toEqual(all.nodes.map((n: Loose) => n.node));
  });

  test("history_tools_a_run_of_format_1_is_read", async () => {
    const answer = await call("history_run_details", { run_id: V1[0] as string });
    expect(answer).toMatchObject({ ok: true, run: { format: 1 } });
  });

  test("history_tools_an_edited_pipeline_copy_does_not_hide_the_history", async () => {
    const specs = join(runsDir(), DEV, "specs");
    for (const file of await readdir(specs))
      await writeFile(join(specs, file), "# edited\n", { flag: "a" });
    // the host refuses to carry the run on: its kept pipeline is not the one it is pinned to
    await expect(host.open(DEV)).rejects.toThrow();
    // reading the history needs no pipeline copy, and says what was changed
    const answer = await call("history_run_details", { run_id: DEV });
    expect(answer.ok).toBe(true);
    expect(answer.run.status).toBe("completed");
    expect(answer.integrity.pipeline_copy).toBe("modified");
  });

  test("history_tools_a_run_before_pipelines_were_kept_is_read", async () => {
    // `meta.json` format 1: read and listed, not carried on by any engine
    const metaFile = join(runsDir(), DEV_OTHER, "meta.json");
    const meta = JSON.parse(await readFile(metaFile, "utf8"));
    await writeFile(metaFile, JSON.stringify({ ...meta, v: 1 }));
    await expect(host.open(DEV_OTHER)).rejects.toThrow();
    const listed = await call("history_runs", { limit: 100 });
    expect(listed.runs.some((r: Loose) => r.run_id === DEV_OTHER && r.status === "completed")).toBe(
      true,
    );
    const answer = await call("history_run_details", { run_id: DEV_OTHER });
    expect(answer).toMatchObject({ ok: true, run: { status: "completed" } });
  });

  test("history_tools_privacy_switches_are_honoured_over_a_store", async () => {
    // this run was started without usage, tool calls or the agent log: each block says so, none is empty
    const answer = await call("history_run_details", { run_id: DEV });
    expect(answer.usage.not_collected).toBe(true);
    expect(answer.tool_calls.not_collected).toBe(true);
    expect(answer.agent_log.not_collected).toBe(true);
  });

  test("history_tools_unknown_runs_nodes_and_attempts", async () => {
    expect(await call("history_run_details", { run_id: "r_000000000_zzzz" })).toMatchObject({
      ok: false,
      code: "UNKNOWN_RUN",
    });
    expect(await call("history_run_details", { run_id: DEV, node: "nope" })).toMatchObject({
      ok: false,
      code: "UNKNOWN_NODE",
    });
    expect(
      await call("history_run_details", { run_id: DEV, node: "plan", attempt: 99 }),
    ).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENTS",
    });
  });
});

describe("history_agent_log over a store", () => {
  const ABOUT = { run_id: LOG_RUN } as const;

  /**
   * The events of the fixture carry times of another day than its journal; the tools place events by time, so the
   * test gives them the times of the journal: the main session's first 16 events and the subagent's in node `a`,
   * the rest in node `b`.
   */
  async function retime() {
    const dir = join(runsDir(), LOG_RUN, "agent_log");
    for (const file of await readdir(dir)) {
      const lines = (await readFile(join(dir, file), "utf8")).split("\n");
      const timed = lines.map((line) => {
        if (line === "") return line;
        const seq = Number(/"seq":(\d+)/.exec(line)?.[1]);
        const sub = file.startsWith("agent-");
        const ms = sub ? 1793088717110 : seq <= 16 ? 1793088717100 : 1793088717150;
        return line.replace(/"ts":"[^"]*"/, `"ts":"${new Date(ms).toISOString()}"`);
      });
      await writeFile(join(dir, file), timed.join("\n"));
    }
  }

  test("history_tools_agent_log_places_events_by_time", async () => {
    await retime();
    const a = await call("history_agent_log", {
      ...ABOUT,
      node: "a",
      attempt: 1,
      include_messages: true,
      limit: 200,
    });
    expect(a).toMatchObject({ ok: true, unverified: true, attribution: "time" });
    const sessions = new Set(a.events.map((e: Loose) => e.session_id));
    expect(sessions.size).toBe(2);
    expect(a.events.length).toBe(18);
    const b = await call("history_agent_log", {
      ...ABOUT,
      node: "b",
      attempt: 1,
      include_messages: true,
      limit: 200,
    });
    expect(b.events.length).toBe(6);
    expect(b.events.every((e: Loose) => e.seq >= 17)).toBe(true);
  });

  test("history_tools_agent_log_messages_behind_flag_over_a_store", async () => {
    await retime();
    const plain = await call("history_agent_log", { ...ABOUT, node: "a", attempt: 1, limit: 200 });
    const full = await call("history_agent_log", {
      ...ABOUT,
      node: "a",
      attempt: 1,
      include_messages: true,
      limit: 200,
    });
    expect(plain.events.every((e: Loose) => e.kind !== "message")).toBe(true);
    expect(plain.events.length + (plain.skipped?.message ?? 0)).toBe(full.events.length);
    expect(plain.skipped.message).toBeGreaterThan(0);
  });

  test("history_tools_agent_log_stops_at_the_journal", async () => {
    await retime();
    const file = join(
      runsDir(),
      LOG_RUN,
      "agent_log",
      "55555555-5555-4555-8555-555555555555.jsonl",
    );
    const extra = JSON.stringify({
      v: 1,
      agent: "claude-code",
      agent_version: "1",
      session_id: "55555555-5555-4555-8555-555555555555",
      seq: 99,
      ts: new Date(1793088717100).toISOString(),
      kind: "system",
      subtype: "forged",
    });
    await writeFile(file, `${extra}\n`, { flag: "a" });
    const answer = await call("history_agent_log", {
      ...ABOUT,
      node: "a",
      attempt: 1,
      include_messages: true,
      limit: 200,
    });
    expect(answer.events.some((e: Loose) => e.seq === 99)).toBe(false);
    expect(answer.partial).toBeUndefined();
  });

  test("history_tools_agent_log_reports_problems_over_a_store", async () => {
    await retime();
    const file = join(
      runsDir(),
      LOG_RUN,
      "agent_log",
      "55555555-5555-4555-8555-555555555555.jsonl",
    );
    const lines = (await readFile(file, "utf8")).split("\n");
    lines[2] = "this is not json";
    await writeFile(file, lines.join("\n"));
    const answer = await call("history_agent_log", {
      ...ABOUT,
      node: "a",
      attempt: 1,
      include_messages: true,
      limit: 200,
    });
    expect(answer.partial).toBe(true);
    expect(answer.problems[0]).toMatchObject({ kind: "damaged" });
    await rm(file);
    const missing = await call("history_agent_log", {
      ...ABOUT,
      node: "a",
      attempt: 1,
      include_messages: true,
      limit: 200,
    });
    expect(missing.problems.some((p: Loose) => p.kind === "missing")).toBe(true);
  });

  test("history_tools_agent_log_not_collected_and_unknown", async () => {
    expect(
      await call("history_agent_log", { run_id: DEV, node: "plan", attempt: 1 }),
    ).toMatchObject({
      ok: true,
      not_collected: true,
      reason: "disabled", // this run was started with history.agent_log off
    });
    expect(await call("history_agent_log", { ...ABOUT, node: "zzz", attempt: 1 })).toMatchObject({
      ok: false,
      code: "UNKNOWN_NODE",
    });
    expect(await call("history_agent_log", { ...ABOUT, node: "a", attempt: 2 })).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENTS",
    });
    expect(
      await call("history_agent_log", { run_id: "r_000000000_zzzz", node: "a", attempt: 1 }),
    ).toMatchObject({
      ok: false,
      code: "UNKNOWN_RUN",
    });
  });

  test("history_tools_agent_log_says_approximate_when_steps_overlap", async () => {
    await retime();
    const plain = await call("history_agent_log", { ...ABOUT, node: "a", attempt: 1, limit: 200 });
    expect(plain.attribution).toBe("time");
    // node b is entered while a is still open (a fork), and two events fall in that window
    const journalFile = join(runsDir(), LOG_RUN, "journal.jsonl");
    const journal = (await readFile(journalFile, "utf8")).split("\n");
    const at = journal.findIndex(
      (l) => l.includes('"event":"node_entered"') && l.includes('"node":"b"'),
    );
    expect(at).toBeGreaterThan(0);
    journal[at] = (journal[at] as string).replace(/"ts":\d+/, '"ts":1793088717120');
    await writeFile(journalFile, journal.join("\n"));
    const file = join(
      runsDir(),
      LOG_RUN,
      "agent_log",
      "55555555-5555-4555-8555-555555555555.jsonl",
    );
    const lines = (await readFile(file, "utf8"))
      .split("\n")
      .map((line) =>
        /"seq":(15|16),/.test(line)
          ? line.replace(/"ts":"[^"]*"/, `"ts":"${new Date(1793088717130).toISOString()}"`)
          : line,
      );
    await writeFile(file, lines.join("\n"));
    const forked = await call("history_agent_log", { ...ABOUT, node: "a", attempt: 1, limit: 200 });
    expect(forked.attribution).toBe("approximate");
  });

  test("history_tools_agent_log_sessions_page_without_a_repeat", async () => {
    await retime();
    const full = await call("history_agent_log", {
      ...ABOUT,
      node: "a",
      attempt: 1,
      include_messages: true,
      limit: 200,
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const answer = await call("history_agent_log", {
        ...ABOUT,
        node: "a",
        attempt: 1,
        include_messages: true,
        limit: 5,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...answer.events.map((e: Loose) => `${e.session_id}:${e.seq}`));
      cursor = answer.page.next;
    } while (cursor);
    expect(seen).toEqual(full.events.map((e: Loose) => `${e.session_id}:${e.seq}`));
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("history_tools_agent_log_a_bad_session_name_is_a_problem_of_that_stream", async () => {
    await retime();
    const journalFile = join(runsDir(), LOG_RUN, "journal.jsonl");
    const text = await readFile(journalFile, "utf8");
    await writeFile(
      journalFile,
      text.replace('"session":"agent-abc123"', '"session":"../../evil"'),
    );
    const answer = await call("history_agent_log", {
      ...ABOUT,
      node: "a",
      attempt: 1,
      include_messages: true,
      limit: 200,
    });
    expect(answer.ok).toBe(true);
    expect(answer.partial).toBe(true);
    expect(answer.problems[0]).toMatchObject({ kind: "damaged" });
  });
});

describe("what the tools never do", () => {
  test("history_tools_do_not_write", async () => {
    const before = await snapshot(join(root, ".kodel"));
    await call("history_runs", { limit: 100 });
    await call("history_run_details", { run_id: DEV });
    await call("history_run_details", { run_id: DEV, node: "impl" });
    await call("history_run_details", { run_id: DEV, node: "impl", attempt: 1 });
    await call("history_agent_log", {
      run_id: LOG_RUN,
      node: "a",
      attempt: 1,
      include_messages: true,
    });
    const after = await snapshot(join(root, ".kodel"));
    expect(after).toEqual(before);
  });

  test("history_tools_do_not_open_the_run_for_work", async () => {
    // opening a run keeps it in the host's cache and can start work; reading its history does neither
    const spy = host as unknown as { runs: Map<string, unknown> };
    await call("history_run_details", { run_id: DEV });
    await call("history_agent_log", { run_id: LOG_RUN, node: "a", attempt: 1 });
    expect(spy.runs.size).toBe(0);
  });

  test("history_tools_redact_with_the_rules_of_the_project", async () => {
    const withRules = new LocalPipelineHost({
      root,
      heartbeatMs: 0,
      integrityDir: join(tmp, "integrity"),
      rules: [{ name: "corp", pattern: /corp-token-[0-9a-f]+/g }],
    });
    expect(withRules.historyRedact("see corp-token-8f3a9c1d here")).not.toContain("8f3a9c1d");
    expect(host.historyRedact("see corp-token-8f3a9c1d here")).toContain("8f3a9c1d");
  });
});

describe("the documentation of the history tools", () => {
  test("history_tools_docs_name_every_parameter_and_code", async () => {
    const { HISTORY_TOOLS } = await import("@kodel-ai/pipeline-core/mcp");
    const docs = await readFile(resolve(FIXTURES, "..", "docs", "history.md"), "utf8");
    const start = docs.indexOf("## History tools");
    expect(start).toBeGreaterThanOrEqual(0);
    const section = docs.slice(start);
    for (const tool of HISTORY_TOOLS) {
      expect(section).toContain(`\`${tool.name}\``);
      for (const parameter of Object.keys(tool.shape)) {
        expect(section).toContain(parameter);
      }
    }
    for (const code of [
      "INVALID_ARGUMENTS",
      "INVALID_CURSOR",
      "UNKNOWN_RUN",
      "UNKNOWN_NODE",
      "UNSUPPORTED_FORMAT",
      "HISTORY_UNAVAILABLE",
    ]) {
      expect(section).toContain(code);
    }
  });
});
