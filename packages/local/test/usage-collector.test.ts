import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEvent, ReadOptions, SessionRef, UsageEvent } from "@kodel-ai/pipeline-core";
import { claudeFolderName, installClaudeSession } from "../../testkit/src";
import { claudeCodeCollector } from "../src/history";

const MARKER = join(".kodel", "config.yaml");
const GOLDEN = new URL("../../../fixtures/formats/v1/history/", import.meta.url).pathname;
/** The hand-made session with the 1-hour cache tier; see its README. */
const TIERS = new URL("../../../fixtures/history/claude-code/v2.1.310/", import.meta.url).pathname;
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
});
