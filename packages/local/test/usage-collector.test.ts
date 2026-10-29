import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addDelta,
  buildDelta,
  defaultPricing,
  type HistoryEvent,
  newTotals,
  type ReadOptions,
  type SessionRef,
  tokensOf,
  type UsageEvent,
} from "@kodel-ai/pipeline-core";
import { ClaudeLogBuilder, claudeFolderName, installClaudeSession } from "../../testkit/src";
import { claudeCodeCollector } from "../src/history";

const MARKER = join(".kodel", "config.yaml");
const GOLDEN = fileURLToPath(new URL("../../../fixtures/formats/v1/history/", import.meta.url));
/** The hand-made session with the 1-hour cache tier; see its README. */
const TIERS = fileURLToPath(
  new URL("../../../fixtures/history/claude-code/v2.1.310/", import.meta.url),
);
const TIERS_SESSION = "33333333-3333-4333-8333-333333333333";

let base: string;
let configDir: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "kodel-usage-collector-")));
  configDir = join(base, "claude");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function project(name = "p"): Promise<string> {
  const root = join(base, name);
  await mkdir(join(root, ".kodel"), { recursive: true });
  await writeFile(join(root, MARKER), "version: 1\n");
  return root;
}

async function collect(source: AsyncIterable<HistoryEvent>): Promise<HistoryEvent[]> {
  const out: HistoryEvent[] = [];
  for await (const event of source) out.push(event);
  return out;
}

const usageOf = (events: HistoryEvent[]): UsageEvent[] =>
  events.filter((e): e is UsageEvent => e.kind === "usage");

/** The hand-made 2.1.310 session in a project; returns the collector and its ref. */
async function tiers() {
  const root = await project();
  const folder = join(configDir, "projects", claudeFolderName(root));
  await mkdir(folder, { recursive: true });
  const text = (await readFile(join(TIERS, "session.jsonl"), "utf8")).replaceAll("__CWD__", root);
  await writeFile(join(folder, `${TIERS_SESSION}.jsonl`), text);
  const collector = claudeCodeCollector({ configDir });
  const ref = (await collector.locate(root)).find((r) => r.session_id === TIERS_SESSION);
  expect(ref).toBeDefined();
  return { collector, ref: ref as SessionRef };
}

const read = (
  collector: ReturnType<typeof claudeCodeCollector>,
  ref: SessionRef,
  options?: ReadOptions,
) => collect(collector.read(ref, undefined, options));

describe("t9jrs the usage events of the collector", () => {
  test("t9jrs_default_collector_options_events_byte_identical", async () => {
    // the options of the usage pass add a field and a rule about stopping; with none of them the events are the golden ones
    const root = await project();
    await installClaudeSession({ configDir, cwd: root });
    const collector = claudeCodeCollector({ configDir });
    const refs = await collector.locate(root);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const text = (await read(collector, ref))
        .map((e) =>
          JSON.stringify(e)
            .replaceAll(root, "__CWD__")
            .replace('"cwd":"__CWD__"', '"cwd":"[REDACTED:high-entropy]"'),
        )
        .join("\n");
      const file = join(
        GOLDEN,
        `claude-code-${ref.session_id === "11111111-1111-4111-8111-111111111111" ? "session" : ref.session_id}.events.jsonl`,
      );
      expect(`${text}\n`).toBe(await readFile(file, "utf8"));
    }
  });

  test("t9jrs_the_default_options_leave_cache_write_1h_out_even_when_the_log_has_it", async () => {
    const { collector, ref } = await tiers();
    const usage = usageOf(await read(collector, ref));
    expect(usage.length).toBe(4);
    expect(usage.every((e) => !("cache_write_1h" in e))).toBe(true);
    expect(usage.map((e) => e.cache_write)).toEqual([12_000, 4_500, 0, 2_500]);
  });

  test("t9jrs_cache_write_1h_is_carried", async () => {
    const { collector, ref } = await tiers();
    const usage = usageOf(await read(collector, ref, { usageDetail: true }));
    // inside cache_write, never added to it
    expect(usage.map((e) => [e.cache_write, e.cache_write_1h])).toEqual([
      [12_000, 12_000],
      [4_500, 4_000],
      [0, 0],
      [2_500, 2_500],
    ]);
    // the 1-hour part is a part: at most the writes
    expect(usage.every((e) => (e.cache_write_1h ?? 0) <= e.cache_write)).toBe(true);
  });

  test("t9jrs_cache_tokens_kept_apart", async () => {
    const { collector, ref } = await tiers();
    const [first, second] = usageOf(await read(collector, ref, { usageDetail: true }));
    expect([first?.input, first?.cache_read, first?.cache_write, first?.output]).toEqual([
      2, 0, 12_000, 300,
    ]);
    expect([second?.input, second?.cache_read, second?.cache_write, second?.output]).toEqual([
      3, 12_000, 4_500, 450,
    ]);
    expect(first?.reasoning).toBe(90);
  });

  test("t9jrs_a_stopped_read_does_not_release_the_open_response_when_usage_detail_is_on", async () => {
    const { collector, ref } = await tiers();
    // stop before the fourth entry: the response of the third is still open
    const stopAfter = (entries: number) => {
      let asked = 0;
      return () => ++asked > entries;
    };
    const plain = usageOf(await read(collector, ref, { shouldStop: stopAfter(3) }));
    const careful = usageOf(
      await read(collector, ref, { shouldStop: stopAfter(3), usageDetail: true }),
    );
    // without the option the response in the middle is released with the usage of its first line
    expect(plain.length).toBe(careful.length + 1);
    expect(careful.map((e) => e.message_id)).toEqual(["msg_1"]);
    // a read that reaches the end of the log still releases the last response
    expect(usageOf(await read(collector, ref, { usageDetail: true })).length).toBe(4);
  });

  test("t9jrs_saved_session_agrees_offline", async () => {
    // SYNTHETIC: the saved session is hand-made (see its README), so "the agent's own figure" is the sum of the last
    // usage line of each response, taken from the raw file with none of the collector's code. What this shows in CI is
    // that the collector and the sums lose and add nothing; agreement with a real agent is the env-gated test of
    // tests/agents/claude-code-usage.test.ts.
    const { collector, ref } = await tiers();
    const raw = (await readFile(join(TIERS, "session.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(
        (line) => JSON.parse(line) as { message?: { id?: string; usage?: Record<string, number> } },
      );
    const last = new Map<string, Record<string, number>>();
    for (const entry of raw) {
      if (entry.message?.id !== undefined && entry.message.usage !== undefined) {
        last.set(entry.message.id, entry.message.usage);
      }
    }
    const own = { input: 0, output: 0, cache_read: 0, cache_write: 0, calls: last.size };
    for (const usage of last.values()) {
      own.input += usage["input_tokens"] ?? 0;
      own.output += usage["output_tokens"] ?? 0;
      own.cache_read += usage["cache_read_input_tokens"] ?? 0;
      own.cache_write += usage["cache_creation_input_tokens"] ?? 0;
    }
    const events = usageOf(await read(collector, ref, { usageDetail: true }));
    const totals = newTotals();
    addDelta(totals, buildDelta(events, defaultPricing()));
    const ours = tokensOf(totals);
    expect({
      input: ours.input,
      output: ours.output,
      cache_read: ours.cache_read,
      cache_write: ours.cache_write,
      calls: ours.api_calls,
    }).toEqual(own);
  });

  test("t9jrs_big_log_is_streamed", async () => {
    // Two synthetic logs, one four times the size of the other, are read as streams. The heap that stays live (sampled
    // after two full collections, so garbage waiting for the next one does not count) is compared between them: an
    // absolute limit on heapUsed measures the collector's timing, not its streaming, and is what failed on CI.
    // The collector does keep a small key per response for the fold of repeated lines (bounded by SEEN_CAP), so the
    // live heap grows with the number of responses: measured, about 0.45 of a byte per extra byte of this log (its
    // responses are short). A log held whole keeps more than one (measured 1.4 when the test held the file as a
    // string). The limit, 0.9, sits between the two; a change that makes the collector keep the log fails it.
    const session = "66666666-6666-4666-8666-666666666666";
    // The log is written in a function of its own, so that its lines (the builder keeps them) are garbage, not a
    // part of the baseline, by the time the heap is measured.
    async function writeLog(root: string, responses: number): Promise<number> {
      const log = new ClaudeLogBuilder({ sessionId: session, cwd: root });
      log.user("go");
      for (let i = 0; i < responses; i += 1) {
        log.say(`msg_${i}`, "x".repeat(300), { input: 10, output: 5 });
      }
      const bytes = (await stat(await log.install(configDir))).size;
      log.lines.length = 0;
      return bytes;
    }
    async function liveHeapWhileReading(name: string, responses: number) {
      const root = await project(name);
      const bytes = await writeLog(root, responses);
      const collector = claudeCodeCollector({ configDir });
      const ref = (await collector.locate(root)).find((r) => r.session_id === session);
      expect(ref).toBeDefined();
      // the live heap while reading: sampled after a full collection (two, the second frees what the first only
      // finalised), the highest sample of the read
      const settle = async () => {
        Bun.gc(true);
        await Bun.sleep(1);
        Bun.gc(true);
        return process.memoryUsage().heapUsed;
      };
      await settle();
      let peak = 0;
      let seen = 0;
      for await (const event of collector.read(ref as SessionRef, undefined, {
        usageDetail: true,
      })) {
        if (event.kind !== "usage") continue;
        seen += 1;
        if (seen % 1_000 === 0) peak = Math.max(peak, await settle());
      }
      expect(seen).toBe(responses);
      return { bytes, peak };
    }
    // a first read warms up what the process allocates once (compiled code, caches), so it is not charged to the first log
    await liveHeapWhileReading("big-warm", 1_000);
    const small = await liveHeapWhileReading("big-small", 3_000);
    const big = await liveHeapWhileReading("big-big", 12_000);
    expect(big.bytes).toBeGreaterThan(4 * small.bytes * 0.9);
    expect(big.bytes).toBeGreaterThan(8_000_000);
    const grown = big.peak - small.peak;
    expect(grown).toBeLessThan((big.bytes - small.bytes) * 0.9);
  }, 60_000);
});
