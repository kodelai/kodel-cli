import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultHistory,
  defaultRegistry,
  type HistoryConfig,
  type JournalRecord,
  type PipelineSpec,
  parsePipeline,
} from "@kodel-ai/pipeline-core";
import { artifactFileName, FileStore, LocalHost, type LocalRun, runCommand } from "../src";
import type { CommandOptions } from "../src/command";
import type { CommandContext } from "../src/host";

// Tests of TASK-CNZ6: command and check output kept in files under artifacts/.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-output-"));
  // A command with no quoting at all, so the same text runs under sh and under cmd.
  await writeFile(
    join(dir, "emit.js"),
    "process.stdout.write(process.argv[2].repeat(Number(process.argv[4] ?? 1)) + '\\n'); process.exit(Number(process.argv[3] ?? 0));",
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const say = (text: string, code = 0) => `node -e "console.log('${text}'); process.exit(${code})"`;

const commandSpec = (command: string) =>
  parsePipeline(
    [
      "name: out",
      "nodes:",
      "  - slug: build",
      "    kind: command",
      `    command: ${command}`,
      "  - slug: look",
      "    kind: human",
      "    prompt: ok?",
      "edges:",
      "  - { from: build, to: look }",
      "  - { from: build, to: look, when: failed }",
      "  - { from: look, to: build, when: rejected }",
      "",
    ].join("\n"),
  );

const checkSpec = (check: string, second = check) =>
  parsePipeline(
    [
      "name: chk",
      "nodes:",
      "  - slug: write",
      "    kind: agent",
      "    prompt: x",
      "    checks:",
      `      - { kind: command, command: '${check}' }`,
      `      - { kind: command, command: '${second}' }`,
      "  - slug: look",
      "    kind: human",
      "    prompt: ok?",
      "edges:",
      "  - { from: write, to: look }",
      "  - { from: look, to: write, when: rejected }",
      "",
    ].join("\n"),
  );

const history = (output: Partial<HistoryConfig["output"]> = {}): HistoryConfig => ({
  ...defaultHistory(),
  changes: { enabled: false, exclude: [], max_kb: 512 },
  output: { enabled: true, max_kb: 64, ...output },
});

async function begin(
  spec: PipelineSpec,
  hist: HistoryConfig | undefined,
  over: Record<string, unknown> = {},
) {
  const host = new LocalHost(spec, { root: dir, heartbeatMs: 0, ...over });
  const { run } = await host.start("t", hist === undefined ? {} : { history: hist });
  return { host, run };
}

const finished = async (host: LocalHost, run: LocalRun, event: string) =>
  (await host.store.readJournal(run.runId)).filter((r: JournalRecord) => r.event === event);

const artifacts = async (host: LocalHost, run: LocalRun) =>
  (await readdir(join(host.store.runDir(run.runId), "artifacts")).catch(() => [])).sort();

describe("cnz6 command output kept in files", () => {
  test("cnz6_success_output_is_kept_and_the_event_points_to_it", async () => {
    const { host, run } = await begin(commandSpec(say("hello there")), history());
    await run.settle();
    const [record] = await finished(host, run, "command_finished");
    expect(record?.output).toEqual({
      ref: "artifacts/build-1-command.txt",
      bytes: Buffer.byteLength("hello there\n"),
      truncated: false,
    });
    const text = await readFile(
      join(host.store.runDir(run.runId), "artifacts/build-1-command.txt"),
      "utf8",
    );
    expect(text).toBe("hello there\n");
  });

  test("cnz6_failure_output_is_kept_and_the_reason_keeps_its_short_tail", async () => {
    const { host, run } = await begin(commandSpec(say("it broke", 2)), history());
    await run.settle();
    const [record] = await finished(host, run, "command_finished");
    expect(record?.passed).toBe(false);
    expect(String(record?.reason)).toContain("it broke");
    expect((record?.output as { ref: string } | undefined)?.ref).toBe(
      "artifacts/build-1-command.txt",
    );
  });

  test("cnz6_a_secret_in_the_output_is_redacted_in_the_file", async () => {
    const { host, run } = await begin(commandSpec(say(`key ${secret}`)), history());
    await run.settle();
    const text = await readFile(
      join(host.store.runDir(run.runId), "artifacts/build-1-command.txt"),
      "utf8",
    );
    expect(text).not.toContain(secret);
    const journal = await readFile(join(host.store.runDir(run.runId), "journal.jsonl"), "utf8");
    expect(journal).not.toContain(secret);
  });

  test("cnz6_a_secret_printed_by_a_failing_command_is_in_neither_the_file_nor_the_journal", async () => {
    const { host, run } = await begin(commandSpec(`node emit.js key-${secret} 3`), history());
    await run.settle();
    const dirOf = host.store.runDir(run.runId);
    const [record] = await finished(host, run, "command_finished");
    expect(record?.passed).toBe(false);
    expect(await readFile(join(dirOf, "artifacts/build-1-command.txt"), "utf8")).not.toContain(
      secret,
    );
    expect(await readFile(join(dirOf, "journal.jsonl"), "utf8")).not.toContain(secret);
  });

  test("cnz6_switched_off_writes_no_file_and_no_output_field", async () => {
    const { host, run } = await begin(commandSpec(say("quiet")), history({ enabled: false }));
    await run.settle();
    expect(await artifacts(host, run)).toEqual([]);
    const [record] = await finished(host, run, "command_finished");
    expect(record).toBeDefined();
    expect(record).not.toHaveProperty("output");
    expect(record).not.toHaveProperty("output_error");
  });

  test("cnz6_a_run_that_recorded_no_history_keeps_nothing", async () => {
    const { host, run } = await begin(commandSpec(say("old run")), undefined);
    await run.settle();
    expect(await artifacts(host, run)).toEqual([]);
    expect(await finished(host, run, "command_finished")).toHaveLength(1);
  });

  test("cnz6_the_limit_comes_from_the_recorded_max_kb_and_truncation_is_marked", async () => {
    const big = `node -e "console.log('x'.repeat(5000))"`;
    const { host, run } = await begin(commandSpec(big), history({ max_kb: 1 }));
    await run.settle();
    const [record] = await finished(host, run, "command_finished");
    const output = record?.output as { ref: string; bytes: number; truncated: boolean };
    expect(output.truncated).toBe(true);
    const text = await readFile(join(host.store.runDir(run.runId), output.ref), "utf8");
    expect(text.startsWith("[earlier output omitted]\n")).toBe(true);
    expect(output.bytes).toBe(Buffer.byteLength(text));
    expect(output.bytes).toBeLessThan(1024 + 64);
  });

  test("cnz6_a_failing_write_keeps_the_verdict_and_records_the_error", async () => {
    // A file where the artifacts folder should be makes the write fail; the command still passes.
    const { host, run } = await begin(commandSpec(say("fine")), history(), {
      runCommand: async (command: string, options: CommandOptions, context: CommandContext) => {
        await writeFile(join(dir, ".kodel", "runs", context.runId, "artifacts"), "in the way");
        return runCommand(command, options);
      },
    });
    await run.settle();
    const [record] = await finished(host, run, "command_finished");
    expect(record?.passed).toBe(true);
    expect(record).not.toHaveProperty("output");
    expect(typeof record?.output_error).toBe("string");
    expect(String(record?.output_error).length).toBeLessThanOrEqual(200);
  });
});

describe("cnz6 check output kept in files", () => {
  const failing = (text: string) => `node emit.js ${text} 1`;

  test("cnz6_a_failed_check_keeps_its_output_and_a_passing_one_does_not", async () => {
    const { host, run } = await begin(checkSpec("node -e 0", failing("nope")), history());
    await run.completeStep("write", 1);
    await run.settle();
    const records = await finished(host, run, "check_finished");
    expect(records.map((r) => r.passed).slice(0, 2)).toEqual([true, false]);
    expect(records[0]).not.toHaveProperty("output");
    expect((records[1]?.output as { ref: string } | undefined)?.ref).toBe(
      "artifacts/write-1-check1.txt",
    );
    expect(records[1]?.command).toBe("node emit.js nope 1");
    expect(await artifacts(host, run)).toEqual(["write-1-check1.txt"]);
    const text = await readFile(
      join(host.store.runDir(run.runId), "artifacts/write-1-check1.txt"),
      "utf8",
    );
    expect(text.trim()).toBe("nope");
  });

  test("cnz6_a_secret_printed_by_a_check_is_redacted_in_the_file_and_the_journal", async () => {
    const { host, run } = await begin(checkSpec(failing(`key-${secret}`)), history());
    await run.completeStep("write", 1);
    await run.settle();
    const dirOf = host.store.runDir(run.runId);
    const [file] = await artifacts(host, run);
    expect(await readFile(join(dirOf, "artifacts", file ?? ""), "utf8")).not.toContain(secret);
    expect(await readFile(join(dirOf, "journal.jsonl"), "utf8")).not.toContain(secret);
  });

  test("cnz6_a_retried_node_keeps_a_file_for_each_attempt", async () => {
    const { host, run } = await begin(checkSpec(failing("again")), history());
    await run.completeStep("write", 1);
    await run.settle();
    await run.completeStep("write", 2);
    await run.settle();
    expect(await artifacts(host, run)).toEqual(["write-1-check0.txt", "write-2-check0.txt"]);
  });

  test("cnz6_a_check_output_is_not_kept_when_the_history_switch_is_off", async () => {
    const { host, run } = await begin(checkSpec(failing("hush")), history({ enabled: false }));
    await run.completeStep("write", 1);
    await run.settle();
    expect(await artifacts(host, run)).toEqual([]);
    const [record] = await finished(host, run, "check_finished");
    expect(record?.passed).toBe(false);
    expect(record).not.toHaveProperty("output");
  });

  test("cnz6_a_failing_write_on_a_check_keeps_the_verdict", async () => {
    const { host, run } = await begin(checkSpec(failing("blocked")), history());
    await writeFile(join(host.store.runDir(run.runId), "artifacts"), "in the way");
    await run.completeStep("write", 1);
    await run.settle();
    const [record] = await finished(host, run, "check_finished");
    expect(record?.passed).toBe(false);
    expect(typeof record?.output_error).toBe("string");
    expect(record).not.toHaveProperty("output");
  });
});

describe("cnz6 limits and paths of the written file", () => {
  const bigFailing = "node emit.js xxxxxxxxxx 1 600";

  test("cnz6_max_kb_of_the_recorded_history_applies_to_a_check", async () => {
    const { host, run } = await begin(checkSpec(bigFailing), history({ max_kb: 1 }));
    await run.completeStep("write", 1);
    await run.settle();
    const [record] = await finished(host, run, "check_finished");
    const output = record?.output as { ref: string; bytes: number; truncated: boolean };
    expect(output.truncated).toBe(true);
    expect(output.bytes).toBeLessThanOrEqual(1024);
    const text = await readFile(join(host.store.runDir(run.runId), output.ref), "utf8");
    expect(text.startsWith("[earlier output omitted]\n")).toBe(true);
  });

  test("cnz6_an_injected_tail_limit_wins_over_the_recorded_one", async () => {
    const { host, run } = await begin(checkSpec(bigFailing), history({ max_kb: 64 }), {
      maxTailBytes: 200,
    });
    await run.completeStep("write", 1);
    await run.settle();
    const [record] = await finished(host, run, "check_finished");
    expect((record?.output as { bytes: number } | undefined)?.bytes).toBeLessThanOrEqual(200);
  });

  test("cnz6_a_node_that_prints_megabytes_leaves_a_file_within_the_default_limit", async () => {
    const { host, run } = await begin(
      commandSpec(`node emit.js 0123456789abcdef 0 400000`),
      history(),
    );
    await run.settle();
    const [record] = await finished(host, run, "command_finished");
    const output = record?.output as { ref: string; bytes: number; truncated: boolean };
    expect(output.truncated).toBe(true);
    expect(output.bytes).toBeLessThanOrEqual(64 * 1024);
    const file = await readFile(join(host.store.runDir(run.runId), output.ref));
    expect(file.length).toBe(output.bytes);
  });

  test("cnz6_crlf_output_is_kept_as_written_in_the_file", async () => {
    await writeFile(join(dir, "crlf.js"), "process.stdout.write('one\\r\\ntwo\\r\\nlast');");
    const { host, run } = await begin(commandSpec("node crlf.js"), history());
    await run.settle();
    const text = await readFile(
      join(host.store.runDir(run.runId), "artifacts/build-1-command.txt"),
      "utf8",
    );
    expect(text).toBe("one\r\ntwo\r\nlast");
  });

  test("cnz6_the_same_output_in_two_attempts_gives_two_files_with_the_same_text", async () => {
    const { host, run } = await begin(checkSpec("node emit.js same 1"), history());
    await run.completeStep("write", 1);
    await run.settle();
    await run.completeStep("write", 2);
    await run.settle();
    const read = (f: string) =>
      readFile(join(host.store.runDir(run.runId), "artifacts", f), "utf8");
    expect(await artifacts(host, run)).toEqual(["write-1-check0.txt", "write-2-check0.txt"]);
    expect(await read("write-1-check0.txt")).toBe(await read("write-2-check0.txt"));
  });

  test("cnz6_a_project_path_with_spaces_works", async () => {
    const parent = dir;
    dir = join(parent, "a project with spaces");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "spaced.js"), "console.log('spaced');");
    const { host, run } = await begin(commandSpec("node spaced.js"), history());
    await run.settle();
    const [record] = await finished(host, run, "command_finished");
    expect((record?.output as { ref: string } | undefined)?.ref).toBe(
      "artifacts/build-1-command.txt",
    );
    dir = parent;
  });

  test("cnz6_a_max_kb_of_zero_in_the_record_keeps_nothing_and_does_not_crash", async () => {
    const { host, run } = await begin(commandSpec(say("zero")), history({ max_kb: 0 }));
    await run.settle();
    expect(await artifacts(host, run)).toEqual([]);
    expect((await run.state()).status).toBe("running");
  });
});

describe("cnz6 what a check runner may put in the event", () => {
  const registry = defaultRegistry().registerCheck({ kind: "plugin", shape: {} });
  const runnerSpec = parsePipeline(
    [
      "name: plug",
      "nodes:",
      "  - slug: write",
      "    kind: agent",
      "    prompt: x",
      "    checks:",
      "      - { kind: plugin }",
      "",
    ].join("\n"),
    { registry },
  );

  test("cnz6_a_plugin_runner_cannot_put_a_foreign_ref_or_a_secret_into_the_event", async () => {
    const checkRunners = {
      plugin: async () => ({
        passed: false,
        reason: "no",
        command: `run ${secret} ${"z".repeat(5000)}`,
        output: { ref: "../../etc/passwd", bytes: 1, truncated: false },
        output_error: `bad ${secret}`,
      }),
    };
    const host = new LocalHost(runnerSpec, {
      root: dir,
      heartbeatMs: 0,
      engine: { registry },
      checkRunners,
    });
    const { run } = await host.start("t", { history: history() });
    await run.completeStep("write", 1);
    await run.settle();
    const [record] = await finished(host, run, "check_finished");
    expect(record).not.toHaveProperty("output");
    expect(String(record?.command)).not.toContain(secret);
    expect(String(record?.command).length).toBeLessThanOrEqual(2000);
    expect(String(record?.output_error)).not.toContain(secret);
  });

  test("cnz6_an_unreadable_journal_changes_no_verdict_and_is_recorded_as_output_error", async () => {
    const host = new LocalHost(commandSpec(say("fine")), { root: dir, heartbeatMs: 0 });
    const original = host.store.readJournal.bind(host.store);
    const broken = true;
    host.store.readJournal = async (runId: string) => {
      if (broken) throw new Error("journal gone");
      return original(runId);
    };
    const { run } = await host.start("t", { history: history() });
    await run.settle();
    const records = await original(run.runId);
    const record = records.find((r) => r.event === "command_finished");
    expect(record?.passed).toBe(true);
    expect(record).not.toHaveProperty("output");
    expect(String(record?.output_error)).toContain("journal gone");
  });
});

describe("cnz6 the store", () => {
  test("cnz6_artifact_names_are_safe_and_do_not_collide", () => {
    expect(artifactFileName("build")).toBe("build");
    expect(artifactFileName("Build")).not.toBe(artifactFileName("build"));
    for (const name of ["../x", "a b", "", "..", "con:"]) {
      const safe = artifactFileName(name);
      expect(safe).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(safe).not.toBe("..");
    }
    expect(artifactFileName("a b")).not.toBe(artifactFileName("a_b"));
    expect(artifactFileName("a b")).not.toBe(artifactFileName("a:b"));
  });

  test("cnz6_write_artifact_redacts_is_atomic_and_counts_what_is_stored", async () => {
    const store = new FileStore({ root: join(dir, ".kodel") });
    const runId = "r_0abcdefgh_abcd";
    await mkdir(store.runDir(runId), { recursive: true });
    const { ref, bytes } = await store.writeArtifact(runId, "a b", 2, "command", `k ${secret}\n`);
    expect(ref).toMatch(/^artifacts\/a_b-[0-9a-f]{8}-2-command\.txt$/);
    const text = await readFile(join(store.runDir(runId), ref), "utf8");
    expect(text).not.toContain(secret);
    expect(bytes).toBe(Buffer.byteLength(text));
    expect(
      (await readdir(join(store.runDir(runId), "artifacts"))).some((f) => f.includes(".tmp-")),
    ).toBe(false);
    await expect(store.writeArtifact(runId, "a", 1, "../x", "t")).rejects.toThrow();
  });

  test("cnz6_reserved_and_long_names_get_a_hash_and_two_attempts_two_files", async () => {
    for (const name of ["con", "NUL", "aux.txt", "lpt1", "trail.", "x".repeat(300)]) {
      const safe = artifactFileName(name);
      expect(safe).toMatch(/-[0-9a-f]{8}$/);
      expect(safe.length).toBeLessThanOrEqual(80);
    }
    const store = new FileStore({ root: join(dir, ".kodel") });
    const runId = "r_0abcdefgh_abcd";
    await mkdir(store.runDir(runId), { recursive: true });
    const one = await store.writeArtifact(runId, "build", 1, "command", "a");
    const two = await store.writeArtifact(runId, "build", 2, "command", "b");
    expect(one.ref).not.toBe(two.ref);
  });

  test("cnz6_names_that_sanitise_alike_write_different_files_and_stay_inside_artifacts", async () => {
    const store = new FileStore({ root: join(dir, ".kodel") });
    const runId = "r_0abcdefgh_abcd";
    await mkdir(store.runDir(runId), { recursive: true });
    const refs = new Set<string>();
    for (const name of ["a b", "a_b", "a:b", "../x", "", ".."]) {
      const { ref } = await store.writeArtifact(runId, name, 1, "command", name);
      expect(ref.startsWith("artifacts/")).toBe(true);
      expect(ref.slice("artifacts/".length)).not.toContain("/");
      expect(ref).not.toMatch(/(^|\/)\.\.(\/|$)/);
      refs.add(ref);
    }
    expect(refs.size).toBe(6);
    expect((await readdir(join(store.runDir(runId), "artifacts"))).length).toBe(6);
  });

  test("cnz6_a_write_into_a_blocked_folder_rejects", async () => {
    const store = new FileStore({ root: join(dir, ".kodel") });
    const runId = "r_0abcdefgh_abcd";
    await mkdir(store.runDir(runId), { recursive: true });
    await writeFile(join(store.runDir(runId), "artifacts"), "in the way");
    await expect(store.writeArtifact(runId, "a", 1, "command", "t")).rejects.toThrow();
  });
});
