/**
 * Run attachments on the local host (T-45): the store, the write under the run's lock, the reads that
 * trust the journal and not the folder, and the path an agent names.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTACHMENT_LIMITS,
  attachmentRef,
  BUILTIN_RULES,
  KodelError,
  type PipelineSpec,
  parsePipeline,
  type RedactRule,
} from "@kodel-ai/pipeline-core";
import { type HostOptions, LocalHost, type LocalRun } from "../src";

let tmp: string;
let dir: string;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "kodel-attachments-")));
  dir = join(tmp, "repo");
  await mkdir(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const SOURCE = [
  "name: planning",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: write the plan }",
  "  - { slug: approval, kind: human, prompt: is the plan right? }",
  "  - { slug: impl, kind: agent, prompt: build it }",
  "edges:",
  "  - { from: plan, to: approval }",
  "  - { from: approval, to: impl, when: approved }",
  "  - { from: approval, to: plan, when: rejected }",
  "",
].join("\n");

const host = (over: Partial<HostOptions> = {}, spec: PipelineSpec = parsePipeline(SOURCE)) =>
  new LocalHost(spec, {
    root: dir,
    heartbeatMs: 0,
    integrityDir: join(tmp, "integrity"),
    source: SOURCE,
    ...over,
  });

async function started(over: Partial<HostOptions> = {}, task = "add a limit"): Promise<LocalRun> {
  const { run } = await host(over).start(task);
  return run;
}

const runDir = (run: LocalRun) => join(dir, ".kodel", "runs", run.runId);
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 0, 5]);

const text = (run: LocalRun, name: string, content: string, node = "plan", attempt = 1) =>
  run.writeAttachment({ node, attempt, name, content });

async function refusal(work: Promise<unknown>): Promise<KodelError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof KodelError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const journal = async (run: LocalRun) =>
  (await readFile(join(runDir(run), "journal.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const written = async (run: LocalRun) =>
  (await journal(run)).filter((r) => r.event === "attachment_written");

const stored = async (run: LocalRun) =>
  (await readdir(join(runDir(run), "attachments")).catch(() => [])).sort();

/** The plan done, the gate decided, so the run is at `impl` (approved) or back at `plan` (rejected). */
async function decide(run: LocalRun, decision: "approved" | "rejected"): Promise<void> {
  const state = await run.state();
  const attempt = state.nodes.plan?.attempt ?? 1;
  await run.completeStep("plan", attempt);
  await run.settle();
  await run.decideHuman("approval", decision, decision === "rejected" ? "again" : undefined);
  await run.settle();
}

describe("t45 a write keeps a version", () => {
  test("t45_write_keeps_redacted_text_and_journals_its_hash", async () => {
    const run = await started({ rules: BUILTIN_RULES });
    const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const given = `# Plan\n\nkey ${secret}\n`;
    const { attachment } = await text(run, "plan.md", given);
    expect(attachment).toMatchObject({
      name: "plan.md",
      version: 1,
      type: "text",
      scanned: true,
      redacted: true,
      node: "plan",
      attempt: 1,
      state: "ok",
      lines: 3,
    });
    const [file] = await stored(run);
    const kept = await readFile(join(runDir(run), "attachments", file as string), "utf8");
    expect(kept).not.toContain(secret);
    expect(kept).toContain("[REDACTED:aws-key]");
    // the hash and the name are of what is stored, not of what was given
    expect(attachment.sha256).toBe(sha(kept));
    expect(file).toBe(`${sha(kept)}-plan.md`);
    expect(attachment.bytes).toBe(Buffer.byteLength(kept));
    const records = await written(run);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).not.toContain("Plan");
    expect(records[0]).toMatchObject({
      sha256: sha(kept),
      ref: `attachments/${file}`,
      redacted: true,
      claim: "none",
    });
    expect("content" in (records[0] ?? {})).toBe(false);
    // a text that needs no redaction carries no mark
    const plain = await text(run, "notes.md", "nothing secret\n");
    expect(plain.attachment.redacted).toBeUndefined();
  });

  test("t45_redaction_does_not_bend_hash_or_ref", async () => {
    const hex: RedactRule = { name: "hex", pattern: /[0-9a-f]{32,}/g };
    const run = await started({ rules: [hex] });
    const { attachment } = await text(run, "plan.md", "plain text\n");
    const [record] = await written(run);
    expect(record?.sha256).toBe(attachment.sha256);
    expect(record?.ref).toBe(attachmentRef(attachment.sha256, "plan.md"));
    // and so the version still verifies and reads
    const read = await run.readAttachment({ name: "plan.md" });
    expect(read.attachment.state).toBe("ok");
    expect(read.content).toBe("plain text\n");
  });

  test("t45_a_name_is_not_a_place_for_a_secret", async () => {
    const rule: RedactRule = { name: "word", pattern: /hunter2/g };
    const run = await started({ rules: [rule] });
    const error = await refusal(text(run, "hunter2.md", "x"));
    expect(error.code).toBe("INVALID_ARGUMENTS");
    expect(error.message).toContain("redaction");
    expect(await written(run)).toEqual([]);
    expect(await stored(run)).toEqual([]);
  });

  test("t45_versions_are_kept", async () => {
    const run = await started();
    await text(run, "plan.md", "one\n");
    await text(run, "plan.md", "two\ntwo\n");
    const third = await text(run, "plan.md", "three\n");
    expect(third.attachment.version).toBe(3);
    expect((await run.readAttachment({ name: "plan.md" })).content).toBe("three\n");
    expect((await run.readAttachment({ name: "plan.md", version: 1 })).content).toBe("one\n");
    expect((await run.readAttachment({ name: "plan.md", version: 2 })).content).toBe("two\ntwo\n");
    expect((await refusal(run.readAttachment({ name: "plan.md", version: 4 }))).message).toContain(
      "no version 4",
    );
    expect((await refusal(run.readAttachment({ name: "other.md" }))).message).toContain(
      "no attachment",
    );
    expect(await stored(run)).toHaveLength(3);
  });

  test("t45_list_gives_the_history_of_a_name", async () => {
    const run = await started();
    await text(run, "plan.md", "one\n");
    await text(run, "notes.txt", "n\n");
    await text(run, "plan.md", "two\ntwo\n");
    const latest = await run.listAttachments();
    expect(latest.map((a) => [a.name, a.version])).toEqual([
      ["notes.txt", 1],
      ["plan.md", 2],
    ]);
    const history = await run.listAttachments({ name: "plan.md" });
    expect(history.map((a) => [a.version, a.node, a.attempt, a.lines, a.bytes])).toEqual([
      [1, "plan", 1, 1, 4],
      [2, "plan", 1, 2, 8],
    ]);
    expect(history.every((a) => a.state === "ok" && /^[0-9a-f]{64}$/.test(a.sha256))).toBe(true);
    expect(await run.listAttachments({ name: "nope.md" })).toEqual([]);
  });

  test("t45_no_op_only_within_one_visit", async () => {
    const run = await started();
    const first = await text(run, "plan.md", "the plan\n");
    // 1. the same bytes again in the same visit of the same step: nothing new
    const again = await text(run, "plan.md", "the plan\n");
    expect(again.unchanged).toBe(true);
    expect(again.attachment.version).toBe(1);
    expect(await written(run)).toHaveLength(1);

    // 2. a new visit of the step (the gate sent it back): a new record that points to the same file
    await decide(run, "rejected");
    const attempt = (await run.state()).nodes.plan?.attempt ?? 0;
    const second = await text(run, "plan.md", "the plan\n", "plan", attempt);
    expect(second.unchanged).toBeUndefined();
    expect(second.attachment.version).toBe(2);
    expect(await stored(run)).toHaveLength(1);

    // 3. another step: its own record, the same file
    await decide(run, "approved");
    const third = await text(run, "plan.md", "the plan\n", "impl");
    expect(third.attachment).toMatchObject({ version: 3, node: "impl" });
    expect(await stored(run)).toHaveLength(1);
    expect((await written(run)).map((r) => r.ref)).toEqual([
      attachmentRef(first.attachment.sha256, "plan.md"),
      attachmentRef(first.attachment.sha256, "plan.md"),
      attachmentRef(first.attachment.sha256, "plan.md"),
    ]);

    // 4. the file was changed outside kodel: the rewrite is a new record beside it, never over it
    const file = join(runDir(run), attachmentRef(first.attachment.sha256, "plan.md"));
    await writeFile(file, "tampered\n");
    const fourth = await text(run, "plan.md", "the plan\n", "impl");
    expect(fourth.unchanged).toBeUndefined();
    expect(fourth.attachment).toMatchObject({ version: 4, state: "ok" });
    expect((await written(run)).at(-1)?.ref).toBe(
      attachmentRef(first.attachment.sha256, "plan.md", 1),
    );
    expect(await readFile(file, "utf8")).toBe("tampered\n");
    expect((await run.readAttachment({ name: "plan.md" })).content).toBe("the plan\n");
    expect((await run.readAttachment({ name: "plan.md", version: 1 })).attachment.state).toBe(
      "changed",
    );
  });
});

describe("t45 the type is the host's finding", () => {
  test("t45_type_is_sniffed_not_believed", async () => {
    const run = await started();
    await writeFile(join(dir, "shot.png"), PNG);
    await writeFile(join(dir, "fake.md"), PNG);
    await writeFile(join(dir, "text.png"), "just text");
    await writeFile(join(dir, "elf.gif"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
    await writeFile(join(dir, "bad.txt"), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
    await writeFile(join(dir, "zero.txt"), Buffer.from([0x61, 0x00, 0x62]));
    const byPath = (name: string, path: string) =>
      run.writeAttachment({ node: "plan", attempt: 1, name, path });

    expect((await byPath("shot.png", "shot.png")).attachment.type).toBe("png");
    for (const [name, path] of [
      ["fake.md", "fake.md"],
      ["text.png", "text.png"],
      ["elf.gif", "elf.gif"],
      ["bad.txt", "bad.txt"],
      ["zero.txt", "zero.txt"],
      // a PNG is not a JPEG whatever the name says
      ["shot.jpg", "shot.png"],
    ] as const) {
      const error = await refusal(byPath(name, path));
      expect(error.code, name).toBe("INVALID_ARGUMENTS");
      expect(error.message, name).toContain("though the name says");
    }
    // an image is never given as text
    expect((await refusal(text(run, "shot.png", "x"))).message).toContain("`path`");
    expect((await written(run)).map((r) => r.name)).toEqual(["shot.png"]);
    expect(await stored(run)).toHaveLength(1);
  });

  test("t45_image_is_kept_unscanned_and_marked", async () => {
    const run = await started({ rules: BUILTIN_RULES });
    await writeFile(join(dir, "shot.png"), PNG);
    const { attachment } = await run.writeAttachment({
      node: "plan",
      attempt: 1,
      name: "shot.png",
      path: join(dir, "shot.png"),
    });
    expect(attachment).toMatchObject({ type: "png", scanned: false, bytes: PNG.length });
    expect(attachment.lines).toBeUndefined();
    const [file] = await stored(run);
    expect(await readFile(join(runDir(run), "attachments", file as string))).toEqual(PNG);
    expect((await written(run))[0]).toMatchObject({ scanned: false, type: "png" });
    expect((await run.listAttachments())[0]).toMatchObject({ scanned: false });
  });

  test("t45_read_never_returns_binary", async () => {
    const run = await started();
    await writeFile(join(dir, "shot.png"), PNG);
    await run.writeAttachment({ node: "plan", attempt: 1, name: "shot.png", path: "shot.png" });
    const read = await run.readAttachment({ name: "shot.png" });
    expect(read.content).toBeUndefined();
    expect(read.attachment).toMatchObject({ type: "png", state: "ok", scanned: false });
  });
});

describe("t45 the path an agent names", () => {
  const byPath = (run: LocalRun, path: string, name = "a.txt") =>
    run.writeAttachment({ node: "plan", attempt: 1, name, path });

  test("t45_path_stays_in_the_workdir", async () => {
    const run = await started();
    const outside = join(tmp, "outside.txt");
    await writeFile(outside, "outside\n");
    await mkdir(join(tmp, "elsewhere"));
    await writeFile(join(tmp, "elsewhere", "x.txt"), "elsewhere\n");
    await writeFile(join(dir, "ok.txt"), "inside\n");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "deep.txt"), "deep\n");
    await symlink(outside, join(dir, "link-out.txt"));
    await symlink(join(tmp, "elsewhere"), join(dir, "dir-link"));
    await symlink(join(dir, "ok.txt"), join(dir, "link-in.txt"));
    await link(join(dir, "ok.txt"), join(dir, "hard.txt"));
    execFileSync("mkfifo", [join(dir, "fifo.txt")]);
    await writeFile(join(dir, ".git", "x.txt"), "git\n");
    await mkdir(join(dir, ".kodel", "runs"), { recursive: true });
    await writeFile(join(dir, ".kodel", "runs", "x.txt"), "runs\n");
    await writeFile(join(dir, ".kodel", "config.yaml"), "# c\n");
    await writeFile(join(dir, "big.txt"), "x".repeat(ATTACHMENT_LIMITS.textBytes + 1));

    const refused: [string, string][] = [
      [outside, "outside the directory"],
      ["../outside.txt", ".."],
      ["link-out.txt", "a link out"],
      ["dir-link/x.txt", "a link inside to outside"],
      ["link-in.txt", "a link"],
      ["hard.txt", "a hard link"],
      ["ok.txt", "the other name of the hard link"],
      ["sub", "a directory"],
      ["fifo.txt", "a FIFO"],
      [".git/x.txt", ".git"],
      [".kodel/runs/x.txt", ".kodel/runs"],
      [".kodel/config.yaml", ".kodel/config.yaml"],
      ["big.txt", "over the cap"],
      ["missing.txt", "a missing file"],
      ["a\0b.txt", "a NUL in the path"],
    ];
    // a disk that does not tell the case of letters apart names the same folders another way
    const insensitive = await stat(join(dir, ".GIT")).then(
      () => true,
      () => false,
    );
    if (insensitive) {
      refused.push([".GIT/x.txt", ".GIT"], [".KODEL/RUNS/x.txt", ".kodel/RUNS"]);
    }
    for (const [path, what] of refused) {
      const error = await refusal(byPath(run, path));
      expect(error.code, what).toBe("INVALID_ARGUMENTS");
    }
    expect((await refusal(byPath(run, "big.txt"))).message).toContain("limit");
    expect(await written(run)).toEqual([]);
    expect(await stored(run)).toEqual([]);

    // a plain file inside is taken, relative or absolute, in a subfolder too
    expect((await byPath(run, "sub/deep.txt")).attachment.bytes).toBe(5);
    expect((await byPath(run, join(dir, "sub", "deep.txt"), "b.txt")).attachment.bytes).toBe(5);
  });

  test("t45_path_swap_is_refused", async () => {
    const secret = join(tmp, "secret.txt");
    await writeFile(secret, "the target\n");
    await writeFile(join(dir, "a.txt"), "harmless\n");
    // between the open and the check the file is swapped for a link to a file outside
    for (const swap of [
      async (path: string) => {
        await rm(path);
        await symlink(secret, path);
      },
      async (path: string) => {
        await rename(path, `${path}.moved`);
        await symlink(secret, path);
      },
    ]) {
      await rm(join(dir, "a.txt"), { force: true });
      await rm(join(dir, "a.txt.moved"), { force: true });
      await writeFile(join(dir, "a.txt"), "harmless\n");
      const run = await started({ attachmentHooks: { afterOpen: swap } });
      const error = await refusal(byPath(run, "a.txt"));
      expect(error.code).toBe("INVALID_ARGUMENTS");
      expect(await written(run)).toEqual([]);
      expect(await stored(run)).toEqual([]);
      await run.cancel();
    }
  });
});

describe("t45 the bounds of a run", () => {
  test("t45_limits_at_and_over_the_bound", async () => {
    const run = await started();
    // one text version: exactly the bound passes, one byte more is refused
    const atBound = "x".repeat(ATTACHMENT_LIMITS.textBytes);
    expect((await text(run, "big.txt", atBound)).attachment.bytes).toBe(
      ATTACHMENT_LIMITS.textBytes,
    );
    await writeFile(join(dir, "over.txt"), `${atBound}y`);
    const over = await refusal(
      run.writeAttachment({ node: "plan", attempt: 1, name: "over.txt", path: "over.txt" }),
    );
    expect(over.message).toContain(String(ATTACHMENT_LIMITS.textBytes));

    // images: exactly 2 MB passes; 8 of them are the 16 MB of a run; one more byte is refused
    const image = (seed: number, size: number = ATTACHMENT_LIMITS.imageBytes) => {
      const bytes = Buffer.alloc(size, seed);
      PNG.copy(bytes, 0, 0, 8);
      return bytes;
    };
    await writeFile(join(dir, "over.png"), image(0, ATTACHMENT_LIMITS.imageBytes + 1));
    const tooBig = await refusal(
      run.writeAttachment({ node: "plan", attempt: 1, name: "over.png", path: "over.png" }),
    );
    expect(tooBig.message).toContain(String(ATTACHMENT_LIMITS.imageBytes));
    const fresh = await started({}, "another task");
    for (let i = 1; i <= 8; i++) {
      await writeFile(join(dir, "shot.png"), image(i));
      const { attachment } = await fresh.writeAttachment({
        node: "plan",
        attempt: 1,
        name: "shot.png",
        path: "shot.png",
      });
      expect(attachment.version).toBe(i);
    }
    const before = { files: await stored(fresh), events: (await written(fresh)).length };
    const full = await refusal(text(fresh, "one.txt", "1"));
    expect(full.message).toContain(`${ATTACHMENT_LIMITS.runBytes} bytes`);
    // a refusal leaves no file and no event, and spends nothing: a version that adds no bytes still fits
    expect(await stored(fresh)).toEqual(before.files);
    expect(await written(fresh)).toHaveLength(before.events);
    await writeFile(join(dir, "shot.png"), image(1));
    const reused = await fresh.writeAttachment({
      node: "plan",
      attempt: 1,
      name: "shot.png",
      path: "shot.png",
    });
    expect(reused.attachment.version).toBe(9);
  }, 60_000);

  test("t45_limits_of_names_and_versions", async () => {
    const run = await started();
    for (let i = 1; i <= ATTACHMENT_LIMITS.names; i++) await text(run, `n${i}.md`, "x");
    const names = await refusal(text(run, "one-more.md", "x"));
    expect(names.message).toContain(`${ATTACHMENT_LIMITS.names} attachment names`);
    // a name the run has takes versions up to the bound of versions
    const left = ATTACHMENT_LIMITS.versions - ATTACHMENT_LIMITS.names;
    for (let i = 0; i < left; i++) await text(run, "n1.md", i % 2 === 0 ? "a" : "b");
    expect(await written(run)).toHaveLength(ATTACHMENT_LIMITS.versions);
    const files = await stored(run);
    const versions = await refusal(text(run, "n1.md", "c"));
    expect(versions.message).toContain(`${ATTACHMENT_LIMITS.versions} attachment versions`);
    expect(await written(run)).toHaveLength(ATTACHMENT_LIMITS.versions);
    expect(await stored(run)).toEqual(files);
    // the same bytes as the latest version are still a no-op, not a refusal
    const latest = (await run.listAttachments({ name: "n1.md" })).at(-1);
    expect((await text(run, "n1.md", left % 2 === 0 ? "b" : "a")).attachment.version).toBe(
      latest?.version as number,
    );
  }, 120_000);

  test("t45_leftovers_are_swept_under_the_lock", async () => {
    const run = await started();
    await text(run, "plan.md", "kept\n");
    const folder = join(runDir(run), "attachments");
    await writeFile(join(folder, `${"0".repeat(64)}-left.md`), "a crash left this\n");
    await writeFile(join(folder, "junk"), "x".repeat(1024));
    // a leftover is no version and counts toward nothing
    expect((await run.listAttachments()).map((a) => a.name)).toEqual(["plan.md"]);
    await text(run, "notes.md", "next\n");
    expect(await stored(run)).toHaveLength(2);
    expect(
      (await stored(run)).every((f) => f.endsWith("-plan.md") || f.endsWith("-notes.md")),
    ).toBe(true);
  });
});

describe("t45 when a write is taken", () => {
  test("t45_write_needs_an_open_agent_step", async () => {
    const run = await started();
    expect((await refusal(text(run, "plan.md", "x", "plan", 2))).code).toBe("ATTEMPT_MISMATCH");
    expect((await refusal(text(run, "plan.md", "x", "impl"))).code).toBe("NODE_NOT_RUNNING");
    expect((await refusal(text(run, "plan.md", "x", "nope"))).code).toBe("UNKNOWN_NODE");
    await run.completeStep("plan", 1);
    await run.settle();
    // at the gate: neither the gate nor the step that led to it
    expect((await refusal(text(run, "plan.md", "x", "approval"))).code).toBe("NODE_NOT_RUNNING");
    expect((await refusal(text(run, "plan.md", "x"))).code).toBe("NODE_NOT_RUNNING");
    expect(await written(run)).toEqual([]);
    expect(await stored(run)).toEqual([]);
    // the refusals are in the journal like those of every other tool
    expect((await journal(run)).filter((r) => r.event === "call_refused").length).toBe(5);
  });

  test("t45_write_never_touches_the_claim", async () => {
    const run = await started();
    const taken = await run.takeStep({ node: "plan" });
    if (taken.status !== "claimed") throw new Error("expected a claim");
    const claim = structuredClone((await run.state()).nodes.plan?.claim);
    await run.writeAttachment({
      node: "plan",
      attempt: 1,
      name: "own.md",
      content: "x",
      claimToken: taken.claim_token,
    });
    await run.writeAttachment({ node: "plan", attempt: 1, name: "other.md", content: "x" });
    await run.writeAttachment({
      node: "plan",
      attempt: 1,
      name: "wrong.md",
      content: "x",
      claimToken: "not-the-token",
    });
    expect((await written(run)).map((r) => [r.name, r.claim])).toEqual([
      ["own.md", "matched"],
      ["other.md", "foreign"],
      ["wrong.md", "foreign"],
    ]);
    const state = await run.state();
    expect(state.nodes.plan?.claim).toEqual(claim as NonNullable<typeof claim>);
    expect(JSON.stringify(await journal(run))).not.toContain(taken.claim_token);
    expect((await journal(run)).some((r) => r.event === "step_claim_conflict")).toBe(false);
  });

  test("t45_crash_between_file_and_journal_is_never_content", async () => {
    let fail = false;
    let seen: string[] = [];
    const run = await started({
      attachmentHooks: {
        afterFile: async () => {
          if (!fail) return;
          seen = await readdir(join(dir, ".kodel", "runs", run.runId, "attachments"));
          throw new Error("the process died here");
        },
      },
    });
    await text(run, "plan.md", "one\n");
    fail = true;
    await expect(text(run, "plan.md", "two\n")).rejects.toThrow("died");
    // the file had been made, and no version came of it: the previous one is still the latest
    expect(seen).toHaveLength(2);
    expect((await run.readAttachment({ name: "plan.md" })).content).toBe("one\n");
    expect(await written(run)).toHaveLength(1);
    expect((await run.listAttachments({ name: "plan.md" })).map((a) => a.version)).toEqual([1]);
    // a real crash leaves the file behind; the next write removes it
    await writeFile(join(runDir(run), "attachments", `${sha("two\n")}-plan.md`), "two\n");
    fail = false;
    await text(run, "notes.md", "n\n");
    expect(await stored(run)).toEqual([`${sha("n\n")}-notes.md`, `${sha("one\n")}-plan.md`].sort());
  });

  test("t45_refused_reuse_keeps_the_earlier_version", async () => {
    let tamper = false;
    const run = await started({
      attachmentHooks: {
        afterFile: async () => {
          // the state is not what kodel wrote: the event is refused after the file was chosen
          if (tamper) await appendFile(join(dir, ".kodel", "runs", run.runId, "state.json"), " ");
        },
      },
    });
    await text(run, "plan.md", "A\n");
    await text(run, "plan.md", "B\n");
    const state = await readFile(join(runDir(run), "state.json"), "utf8");
    tamper = true;
    const refusedReuse = await refusal(text(run, "plan.md", "A\n"));
    expect(refusedReuse.code).toBe("STATE_MODIFIED_EXTERNALLY");
    const refusedNew = await refusal(text(run, "plan.md", "C\n"));
    expect(refusedNew.code).toBe("STATE_MODIFIED_EXTERNALLY");
    tamper = false;
    await writeFile(join(runDir(run), "state.json"), state);
    // version 1 kept its file though the refused write pointed to it; the refused new file is gone
    expect((await run.readAttachment({ name: "plan.md", version: 1 })).content).toBe("A\n");
    expect((await run.readAttachment({ name: "plan.md" })).content).toBe("B\n");
    expect(await stored(run)).toEqual([`${sha("A\n")}-plan.md`, `${sha("B\n")}-plan.md`].sort());
    expect(await written(run)).toHaveLength(2);
  });

  test("t45_read_during_a_write_sees_the_last_journaled_version", async () => {
    let during: string | undefined;
    const run = await started({
      attachmentHooks: {
        afterFile: async () => {
          during = (await run.readAttachment({ name: "plan.md" }).catch(() => undefined))?.content;
        },
      },
    });
    await text(run, "plan.md", "one\n");
    during = undefined;
    await text(run, "plan.md", "two\n");
    expect(during as string | undefined).toBe("one\n");
    expect((await run.readAttachment({ name: "plan.md" })).content).toBe("two\n");
  });

  test("t45_concurrent_writes_are_serialized", async () => {
    const run = await started();
    const other = host().open(run.runId);
    const results = await Promise.all([
      text(run, "plan.md", "from one\n"),
      text(other, "plan.md", "from two\n"),
      text(run, "plan.md", "from three\n"),
      text(other, "notes.md", "n\n"),
    ]);
    const versions = results
      .filter((r) => r.attachment.name === "plan.md")
      .map((r) => r.attachment.version)
      .sort();
    expect(versions).toEqual([1, 2, 3]);
    const records = await written(run);
    expect(records).toHaveLength(4);
    expect(new Set(records.map((r) => r.seq)).size).toBe(4);
    expect(await stored(run)).toHaveLength(4);
    for (const info of await run.listAttachments({ name: "plan.md" })) {
      expect(info.state).toBe("ok");
    }
  });
});

describe("t45 a read trusts the journal, not the folder", () => {
  test("t45_read_trusts_the_journal_not_the_folder", async () => {
    const run = await started();
    const { attachment } = await text(run, "plan.md", "the plan\n");
    const folder = join(runDir(run), "attachments");
    const file = join(folder, `${attachment.sha256}-plan.md`);

    // a file with no record is not an attachment
    await writeFile(join(folder, `${sha("x")}-planted.md`), "x");
    expect((await run.listAttachments()).map((a) => a.name)).toEqual(["plan.md"]);
    expect((await refusal(run.readAttachment({ name: "planted.md" }))).message).toContain(
      "no attachment",
    );

    const read = async () => {
      const found = await run.readAttachment({ name: "plan.md" });
      return { state: found.attachment.state, content: found.content, path: found.path };
    };
    expect(await read()).toEqual({ state: "ok", content: "the plan\n", path: file });

    // an edited file: no content and no path
    await writeFile(file, "the plot\n");
    expect(await read()).toEqual({ state: "changed", content: undefined, path: undefined });
    // a link in the place of the file, even to the right bytes
    await rm(file);
    await writeFile(join(tmp, "right.md"), "the plan\n");
    await symlink(join(tmp, "right.md"), file);
    expect(await read()).toEqual({ state: "changed", content: undefined, path: undefined });
    // a missing file
    await rm(file);
    expect(await read()).toEqual({ state: "missing", content: undefined, path: undefined });
    expect((await run.listAttachments())[0]?.state).toBe("missing");
    // a link in the place of the folder
    await rm(folder, { recursive: true });
    await mkdir(join(tmp, "elsewhere"));
    await writeFile(join(tmp, "elsewhere", `${attachment.sha256}-plan.md`), "the plan\n");
    await symlink(join(tmp, "elsewhere"), folder);
    expect(await read()).toEqual({ state: "missing", content: undefined, path: undefined });
    // and nothing is written through it either
    expect((await refusal(text(run, "notes.md", "n\n"))).message).toContain("not a plain folder");
    expect(await readdir(join(tmp, "elsewhere"))).toHaveLength(1);
  });

  test("t45_limit_a_forged_journal_line_is_an_attachment", async () => {
    // Decision 2 of T-45, pinned: the journal of an open run is at the agent's trust level, so a
    // line written around the tools, with its file, reads as a version. If this test fails because
    // the forged line is refused, the limit was lifted: update docs/attachments.md.
    const run = await started();
    await text(run, "plan.md", "real\n");
    const forged = "never redacted, never limited\n";
    const hash = sha(forged);
    await writeFile(join(runDir(run), "attachments", `${hash}-forged.md`), forged);
    const last = (await journal(run)).at(-1) as { seq: number; v: number };
    await appendFile(
      join(runDir(run), "journal.jsonl"),
      `${JSON.stringify({
        v: last.v,
        seq: last.seq + 1,
        ts: 1,
        event: "attachment_written",
        node: "plan",
        attempt: 1,
        name: "forged.md",
        version: 1,
        ref: `attachments/${hash}-forged.md`,
        type: "text",
        bytes: Buffer.byteLength(forged),
        lines: 1,
        sha256: hash,
        scanned: true,
        claim: "none",
      })}\n`,
    );
    const read = await run.readAttachment({ name: "forged.md" });
    expect(read.attachment.state).toBe("ok");
    expect(read.content).toBe(forged);
    // what the forgery cannot do: point out of the folder, or pass for another type
    await appendFile(
      join(runDir(run), "journal.jsonl"),
      `${JSON.stringify({
        v: last.v,
        seq: last.seq + 2,
        ts: 1,
        event: "attachment_written",
        node: "plan",
        attempt: 1,
        name: "out.md",
        version: 1,
        ref: "attachments/../state.json",
        type: "text",
        bytes: 1,
        sha256: hash,
        scanned: true,
      })}\n`,
    );
    expect((await run.listAttachments()).map((a) => a.name)).toEqual(["forged.md", "plan.md"]);
  });

  test("t45_edit_after_seal_shows", async () => {
    const run = await started();
    const { attachment } = await text(run, "plan.md", "the plan\n");
    await decide(run, "approved");
    await run.completeStep("impl", 1);
    await run.settle();
    expect((await run.state()).status).toBe("completed");
    expect(await run.sealStatus()).toBe("sealed");
    // a finished run still reads
    expect((await run.readAttachment({ name: "plan.md" })).content).toBe("the plan\n");
    // an edit of the stored file shows in the read; an edit of the journal shows in the seal
    await writeFile(join(runDir(run), "attachments", `${attachment.sha256}-plan.md`), "edited\n");
    const read = await run.readAttachment({ name: "plan.md" });
    expect(read.attachment.state).toBe("changed");
    expect(read.content).toBeUndefined();
    await appendFile(join(runDir(run), "journal.jsonl"), `${JSON.stringify({ v: 2 })}\n`);
    expect(await run.sealStatus()).toBe("modified");
    // and nothing is written to a run that is over
    expect((await refusal(text(run, "plan.md", "late\n", "impl"))).code).toBe("NODE_NOT_RUNNING");
  });
});

describe("t45 an attachment is not a project change", () => {
  test("t45_attachment_is_not_a_project_change", async () => {
    const source = [
      "name: checked",
      "nodes:",
      "  - slug: plan",
      "    kind: agent",
      "    prompt: write the plan",
      "    checks:",
      "      - { kind: diff, paths: ['docs/**'], mode: changed_only }",
      "  - { slug: approval, kind: human, prompt: ok? }",
      "edges:",
      "  - { from: plan, to: approval }",
      "  - { from: approval, to: plan, when: rejected }",
      "",
    ].join("\n");
    // the history is kept outside the working tree here, as a project that does not track it has it
    await writeFile(join(dir, ".gitignore"), ".kodel/\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "ignore"], { cwd: dir });
    const { run } = await host({ source }, parsePipeline(source)).start("t");
    await mkdir(join(dir, "docs"));
    await writeFile(join(dir, "docs", "plan.md"), "in the tree\n");
    await text(run, "plan.md", "with the run\n");
    await writeFile(join(dir, "shot.png"), PNG);
    await rm(join(dir, "shot.png"));
    // nothing appeared in the tree but what the agent itself wrote there
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    expect(status.trim()).toBe("?? docs/");
    await run.completeStep("plan", 1);
    await run.settle();
    // `changed_only` still passes: the attachment is no change of the project
    const step = await run.nextStep();
    if (!("waiting" in step)) throw new Error(`expected a gate: ${JSON.stringify(step)}`);
    expect(step.waiting.node_slug).toBe("approval");
    expect(Object.keys(step.waiting.changes ?? {})).toEqual(["docs/plan.md"]);
  });
});
