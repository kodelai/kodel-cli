/**
 * The `engines:` block of the project config and the kept copy of a pipeline that names a field this
 * kodel does not know (T-42, TASK-WKJ4 PR 1).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KodelError, parsePipeline } from "@kodel-ai/pipeline-core";
import { CONFIG_FILE, configProblem, loadConfig, newerKeptCopy } from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-engines-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (text: string) => writeFile(join(dir, CONFIG_FILE), text);

describe("t42 the engines block", () => {
  test("t42_engines_config_loads", async () => {
    await write(
      [
        "engines:",
        "  reviewer:",
        "    command: [claude, -p, --output-format, json]",
        "    model_flag: --model",
        "    pass_env: [ANTHROPIC_API_KEY]",
        "    env: { MODE: review }",
        "    timeout: 900",
        "",
      ].join("\n"),
    );
    expect((await loadConfig(dir)).engines).toEqual({
      reviewer: {
        command: ["claude", "-p", "--output-format", "json"],
        model_flag: "--model",
        pass_env: ["ANTHROPIC_API_KEY"],
        env: { MODE: "review" },
        timeout: 900,
      },
    });
  });

  test("t42_no_engines_block_changes_nothing", async () => {
    await write("version: 1\n");
    expect((await loadConfig(dir)).engines).toEqual({});
  });

  test("t42_engines_config_rejects", async () => {
    const rows = [
      "engines:\n  r:\n    command: [x]\n    unknown: 1\n",
      "engines:\n  r:\n    command: []\n",
      "engines:\n  r:\n    command: [x]\n    timeout: 0\n",
      "engines:\n  r:\n    command: [x]\n    pass_env: [KODEL_STATE_DIR]\n",
      "engines:\n  r:\n    command: [x]\n    env: { 'bad name': v }\n",
      "engines:\n  Bad:\n    command: [x]\n",
      "engines:\n  r:\n    command: [x]\n    env: { HOME: /elsewhere }\n",
      "engines:\n  r:\n    command: [x]\n    pass_env: [HOME]\n",
      "engines:\n  r:\n    command: [x]\n    pass_env: [USERPROFILE]\n",
    ];
    for (const row of rows) {
      await write(row);
      const error = await loadConfig(dir).catch((e: unknown) => e);
      expect(error, row).toBeInstanceOf(KodelError);
    }
  });
});

describe("t42 a profile may not move the state base", () => {
  test("t42_home_in_profile_env_refused", async () => {
    await write("engines:\n  r:\n    command: [x]\n    env: { HOME: /elsewhere }\n");
    const error = (await loadConfig(dir).catch((e: unknown) => e)) as KodelError;
    expect(error.message).toContain("HOME moves where kodel keeps its state");
    // and at the launch, for a profile that did not come through the config
    const { configEngineResolver } = await import("../src");
    for (const profile of [
      { command: ["x"], env: { HOME: "/elsewhere" } },
      { command: ["x"], pass_env: ["HOME"] },
    ]) {
      const out = await configEngineResolver(
        async () => ({ r: profile }),
        () => ({ HOME: "/h" }),
      ).resolve({ profile: "r", prompt: "p" }, { cwd: "/w" });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toContain("HOME");
    }
  });
});

describe("t42 a kept copy written by a newer kodel", () => {
  test("t42_hash_matched_unparseable_copy_says_upgrade", () => {
    // a field this kodel does not know, in a copy whose hash matched: "upgrade kodel", not "modified"
    const text =
      "name: p\nnodes:\n  - slug: a\n    kind: agent\n    prompt: x\n    future_field: 1\n";
    let error: unknown;
    try {
      parsePipeline(text);
    } catch (e) {
      error = e;
    }
    const said = newerKeptCopy(error, "r_x");
    expect(said?.code).toBe("UNSUPPORTED_FORMAT");
    expect(said?.message).toContain("upgrade kodel");
    // any other problem is not called newer
    let other: unknown;
    try {
      parsePipeline("name: p\nnodes:\n  - slug: a\n    kind: agent\n");
    } catch (e) {
      other = e;
    }
    expect(newerKeptCopy(other, "r_x")).toBeUndefined();
  });

  test("t42_hash_matched_unparseable_copy_says_upgrade_through_the_store", async () => {
    // The door every kept copy is read through (its callers have checked the hash before it): a copy
    // the journal names as the run's, with a field this kodel does not know, says "upgrade kodel"; the
    // same text introduced now (an accepted change) is refused as an invalid pipeline.
    const { FileStore } = await import("../src");
    const { mkdir: mk, writeFile: wf } = await import("node:fs/promises");
    const store = new FileStore({ root: dir });
    const runId = "r_0mw0abcde_xxxx";
    await mk(join(dir, "runs", runId), { recursive: true });
    await wf(
      join(dir, "runs", runId, "journal.jsonl"),
      `${JSON.stringify({ v: 2, seq: 1, ts: 1, event: "run_started", spec: "h" })}\n`,
    );
    const text = "name: p\nnodes:\n  - slug: a\n    kind: agent\n    prompt: x\n    engine2: r\n";
    const kept = await store.parseKept(runId, "h", text).catch((e: unknown) => e);
    expect((kept as KodelError).code).toBe("UNSUPPORTED_FORMAT");
    expect((kept as KodelError).message).toContain("upgrade kodel");
    const introduced = await store
      .parseKept(runId, "h2", text, { introducing: true })
      .catch((e: unknown) => e);
    expect((introduced as KodelError).code).toBe("PIPELINE_INVALID");
  });
});

describe("t42 a config that cannot be read at a start", () => {
  test("t42_config_problem_names_the_place_not_the_line", async () => {
    const secret = "sk-literal-value-0123456789";
    await write(`engines:\n  r:\n    command: [x]\n    env: { TOKEN: "${secret}" }\n  bad: [\n`);
    const error = await loadConfig(dir).catch((e: unknown) => e);
    const said = configProblem(error);
    expect(said).toContain("config.yaml");
    expect(said).not.toContain(secret);
    expect(said).not.toContain("TOKEN");
  });
});
