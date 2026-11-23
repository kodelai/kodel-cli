/**
 * The `attachment` check on the local host (T-45): it passes only on a verified version the step
 * itself kept in its current visit, and a host or a format without attachments refuses the pipeline.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_RULES,
  defaultRegistry,
  KodelError,
  type PipelineSpec,
  parsePipeline,
  type RunState,
} from "@kodel-ai/pipeline-core";
import {
  type CommandResult,
  type HostOptions,
  LocalHost,
  LocalPipelineHost,
  type LocalRun,
  localRegistry,
} from "../src";

const FORMATS = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "formats",
);

let tmp: string;
let dir: string;
/** What the scripted `verify` command exits with. */
let verifyExit = 0;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "kodel-attachments-check-")));
  dir = join(tmp, "repo");
  await mkdir(dir);
  verifyExit = 0;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const yaml = (lines: string[]) => `${lines.join("\n")}\n`;

const CHECKED = yaml([
  "name: checked",
  "nodes:",
  "  - slug: plan",
  "    kind: agent",
  "    prompt: write the plan",
  "    max_consecutive_failures: 5",
  "    max_attempts: 9",
  "    checks:",
  "      - { kind: attachment, name: plan.md, min_lines: 2 }",
  "      - { kind: command, command: verify }",
  "  - { slug: approval, kind: human, prompt: fine? }",
  "  - slug: impl",
  "    kind: agent",
  "    prompt: build it",
  "    checks:",
  "      - { kind: attachment, name: plan.md }",
  "edges:",
  "  - { from: plan, to: approval }",
  "  - { from: approval, to: impl, when: approved }",
  "  - { from: approval, to: plan, when: rejected }",
]);

const FORK = yaml([
  "name: fork",
  "nodes:",
  "  - { slug: start, kind: agent, prompt: start }",
  "  - slug: a",
  "    kind: agent",
  "    prompt: a",
  "    checks: [{ kind: attachment, name: plan.md }]",
  "  - { slug: a-gate, kind: human, prompt: a fine? }",
  "  - slug: b",
  "    kind: agent",
  "    prompt: b",
  "    checks: [{ kind: attachment, name: plan.md }]",
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: start, to: a }",
  "  - { from: start, to: b }",
  "  - { from: a, to: a-gate }",
  "  - { from: a-gate, to: merge, when: approved }",
  "  - { from: a-gate, to: a, when: rejected }",
  "  - { from: b, to: merge }",
]);

const scripted = async (): Promise<CommandResult> => ({
  exit: verifyExit,
  timedOut: false,
  aborted: false,
  tail: verifyExit === 0 ? "" : "scripted failure",
  truncated: false,
  durationMs: 0,
});

const local = (source: string): PipelineSpec =>
  parsePipeline(source, { registry: localRegistry() });

function host(source: string, over: Partial<HostOptions> = {}): LocalHost {
  return new LocalHost(local(source), {
    root: dir,
    heartbeatMs: 0,
    integrityDir: join(tmp, "integrity"),
    source,
    runCommand: scripted,
    ...over,
  });
}

async function started(source = CHECKED, over: Partial<HostOptions> = {}): Promise<LocalRun> {
  return (await host(source, over).start("t")).run;
}

const text = (run: LocalRun, node: string, content: string, attempt = 1, name = "plan.md") =>
  run.writeAttachment({ node, attempt, name, content });

/** Hand the step in and let its checks run; what the node is then. */
async function complete(run: LocalRun, node: string, attempt = 1, token?: string) {
  const done = await run.completeStep(node, attempt, undefined, undefined, undefined, token);
  if (!done.ok) throw done.error;
  await run.settle();
  const state: RunState = await run.state();
  const at = state.nodes[node];
  return { status: at?.status, attempt: at?.attempt, reason: at?.lastFailure?.reason ?? "" };
}

const runDir = (run: LocalRun) => join(dir, ".kodel", "runs", run.runId);

async function refusal(work: Promise<unknown>): Promise<KodelError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof KodelError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("t45 the attachment check", () => {
  test("t45_check_fails_without_a_write", async () => {
    const run = await started();
    const failed = await complete(run, "plan");
    expect(failed).toMatchObject({ status: "rework", attempt: 2 });
    expect(failed.reason).toContain('kept no attachment "plan.md" in this visit');
    expect(failed.reason).toContain("pipeline_attachment_write");
    // another name does not count
    await text(run, "plan", "a\nb\n", 2, "notes.md");
    expect((await complete(run, "plan", 2)).status).toBe("rework");
    // the name the check asks for does
    await text(run, "plan", "a\nb\n", 3);
    expect((await complete(run, "plan", 3)).status).toBe("passed");
  });

  test("t45_min_lines_counts_what_is_stored", async () => {
    // a private key takes many lines as given and one as stored: the check counts what is stored
    const key = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
      "KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const run = await started(CHECKED, { rules: BUILTIN_RULES });
    const { attachment } = await text(run, "plan", `${key}\n`);
    expect(attachment).toMatchObject({ lines: 1, redacted: true });
    const short = await complete(run, "plan");
    expect(short.status).toBe("rework");
    expect(short.reason).toBe('the attachment "plan.md" has 1 lines, at least 2 required');
    // exactly the bound passes
    await text(run, "plan", "one\ntwo\n", 2);
    expect((await complete(run, "plan", 2)).status).toBe("passed");
  });

  test("t45_check_wants_this_visit_of_this_node", async () => {
    const run = await started();
    await text(run, "plan", "one\ntwo\n");
    expect((await complete(run, "plan")).status).toBe("passed");
    // another node's version: `impl` asks for plan.md and `plan` wrote it
    await run.decideHuman("approval", "approved");
    await run.settle();
    const other = await complete(run, "impl");
    expect(other.status).toBe("rework");
    expect(other.reason).toContain("kept no attachment");

    // a version from an earlier entry: sent back, the step is entered again and its old version is
    // not of this visit
    await run.cancel();
    const fresh = (await host(CHECKED).start("another task")).run;
    await text(fresh, "plan", "one\ntwo\n");
    expect((await complete(fresh, "plan")).status).toBe("passed");
    await fresh.decideHuman("approval", "rejected", "again");
    await fresh.settle();
    const attempt = (await fresh.state()).nodes.plan?.attempt ?? 0;
    const stale = await complete(fresh, "plan", attempt);
    expect(stale.status).toBe("rework");
    expect(stale.reason).toContain("in this visit");
  });

  test("t45_check_survives_a_retry_in_the_same_visit", async () => {
    const run = await started();
    await text(run, "plan", "one\ntwo\n");
    // the attachment check passes and the command after it fails: the step is retried
    verifyExit = 1;
    const failed = await complete(run, "plan");
    expect(failed).toMatchObject({ status: "rework", attempt: 2 });
    expect(failed.reason).toContain("exited with 1");
    // the retry is the same visit: the version written before it still counts, with no fresh write
    verifyExit = 0;
    expect((await complete(run, "plan", 2)).status).toBe("passed");
    expect((await run.listAttachments({ name: "plan.md" })).map((a) => a.attempt)).toEqual([1]);
  });

  test("t45_check_passes_on_same_bytes_in_a_new_visit", async () => {
    const run = await started();
    await text(run, "plan", "one\ntwo\n");
    expect((await complete(run, "plan")).status).toBe("passed");
    await run.decideHuman("approval", "rejected", "again");
    await run.settle();
    const attempt = (await run.state()).nodes.plan?.attempt ?? 0;
    // the same bytes again: not a no-op in a new visit, so the step is never stuck with a plan it
    // has no reason to change
    const again = await text(run, "plan", "one\ntwo\n", attempt);
    expect(again.unchanged).toBeUndefined();
    expect(again.attachment.version).toBe(2);
    expect((await complete(run, "plan", attempt)).status).toBe("passed");
  });

  test("t45_check_fails_closed", async () => {
    // 1. under min_lines
    const short = await started();
    await text(short, "plan", "only one line\n");
    expect((await complete(short, "plan")).reason).toContain("at least 2 required");
    await short.cancel();

    // 2. the stored file does not hash to what the journal recorded
    const edited = (await host(CHECKED).start("second")).run;
    const { attachment } = await text(edited, "plan", "one\ntwo\n");
    await writeFile(join(runDir(edited), "attachments", `${attachment.sha256}-plan.md`), "x\ny\n");
    const mismatch = await complete(edited, "plan");
    expect(mismatch.status).toBe("rework");
    expect(mismatch.reason).toContain("was changed outside kodel");
    await rm(join(runDir(edited), "attachments", `${attachment.sha256}-plan.md`));
    expect((await complete(edited, "plan", 2)).reason).toContain("is missing");
    await edited.cancel();

    // 3. a journal that cannot be read: the runner says so and does not pass
    const h = host(CHECKED);
    const broken = (await h.start("third")).run;
    await text(broken, "plan", "one\ntwo\n");
    const journal = join(runDir(broken), "journal.jsonl");
    const lines = (await readFile(journal, "utf8")).trim().split("\n");
    await writeFile(journal, `${[lines[0], "{not json", ...lines.slice(1)].join("\n")}\n`);
    const runner = h.checkRunners.attachment;
    if (!runner) throw new Error("the local host has no runner for the attachment check");
    const verdict = await runner(
      {
        type: "run_check",
        node: "plan",
        attempt: 1,
        index: 0,
        kind: "attachment",
        params: { name: "plan.md" },
        restart: false,
      },
      {
        runId: broken.runId,
        signal: new AbortController().signal,
        store: h.store,
        snapshotter: h.snapshotter,
        cwd: dir,
      },
    );
    expect(verdict).toEqual({ passed: false, reason: "the journal of the run cannot be read" });
  });

  test("t45_check_in_a_fork_judges_its_own_node", async () => {
    const run = await started(FORK);
    await run.completeStep("start", 1);
    await run.settle();
    // `a` wrote the plan; `b` did not, and a's version is not b's
    await text(run, "a", "the plan of a\n");
    expect((await complete(run, "a")).status).toBe("passed");
    const without = await complete(run, "b");
    expect(without.status).toBe("rework");
    expect(without.reason).toContain("kept no attachment");
    // both branches write the same name: each check judges the version its own node wrote
    await text(run, "b", "the plan of b\n", 2);
    expect((await complete(run, "b", 2)).status).toBe("passed");
    // the sibling's later write changed nothing for the check that had passed
    const state = await run.state();
    expect(state.nodes.a).toMatchObject({ status: "passed", outcome: "passed" });
    expect((await run.listAttachments({ name: "plan.md" })).map((v) => v.node)).toEqual(["a", "b"]);
  });

  test("t45_check_wants_the_claims_token", async () => {
    const run = await started();
    const taken = await run.takeStep({ node: "plan" });
    if (taken.status !== "claimed") throw new Error("expected a claim");
    // a write for a claimed step without its token is journaled, and does not count
    await text(run, "plan", "one\ntwo\n");
    const foreign = await complete(run, "plan", 1, taken.claim_token);
    expect(foreign.status).toBe("rework");
    expect(foreign.reason).toContain("without the claim token");
    // with the token it does
    const again = await run.takeStep({ node: "plan", token: taken.claim_token });
    if (again.status !== "renewed" && again.status !== "claimed") {
      throw new Error(`expected the claim again, got ${again.status}`);
    }
    await run.writeAttachment({
      node: "plan",
      attempt: 2,
      name: "plan.md",
      content: "one\ntwo\nthree\n",
      claimToken: taken.claim_token,
    });
    expect((await complete(run, "plan", 2, taken.claim_token)).status).toBe("passed");
  });
});

describe("t45 the same bytes and the claim", () => {
  test("t45_same_bytes_with_the_token_after_a_foreign_write_counts", async () => {
    const run = await started();
    const taken = await run.takeStep({ node: "plan" });
    if (taken.status !== "claimed") throw new Error("expected a claim");
    // someone writes the plan for the claimed step without its token: journaled, and it does not count
    const foreign = await text(run, "plan", "one\ntwo\n");
    expect(foreign.attachment.version).toBe(1);
    // the holder writes the same bytes with its token: not a no-op, or its check could never pass
    const own = await run.writeAttachment({
      node: "plan",
      attempt: 1,
      name: "plan.md",
      content: "one\ntwo\n",
      claimToken: taken.claim_token,
    });
    expect(own.unchanged).toBeUndefined();
    expect(own.attachment.version).toBe(2);
    const records = (await run.attachmentRecords()).map((r) => [r.version, r.claim, r.ref]);
    expect(records.map(([version, claim]) => [version, claim])).toEqual([
      [1, "foreign"],
      [2, "matched"],
    ]);
    // one stored file for the two records
    expect(records[0]?.[2]).toBe(records[1]?.[2] as string);
    // the same write once more is nothing new, and the other way round is a record again
    const again = await run.writeAttachment({
      node: "plan",
      attempt: 1,
      name: "plan.md",
      content: "one\ntwo\n",
      claimToken: taken.claim_token,
    });
    expect(again.unchanged).toBe(true);
    expect((await text(run, "plan", "one\ntwo\n")).attachment.version).toBe(3);
    await run.writeAttachment({
      node: "plan",
      attempt: 1,
      name: "plan.md",
      content: "one\ntwo\n",
      claimToken: taken.claim_token,
    });
    expect((await complete(run, "plan", 1, taken.claim_token)).status).toBe("passed");
  });
});

describe("t45 where the check kind exists", () => {
  test("t45_no_attachment_store_no_attachment_check", async () => {
    // a host that was given the built-in kinds only: the pipeline is not a pipeline there
    const plain = yaml([
      "name: plain",
      "nodes:",
      "  - { slug: plan, kind: agent, prompt: plan }",
      "edges: []",
    ]);
    const without = new LocalHost(parsePipeline(plain), {
      root: dir,
      heartbeatMs: 0,
      integrityDir: join(tmp, "integrity"),
      source: plain,
      engine: { registry: defaultRegistry() },
    });
    expect(() => parsePipeline(CHECKED)).toThrow('unknown check kind "attachment"');
    expect(without.checkRunners.attachment).toBeDefined();
    const { run } = await without.start("t");
    // refused when proposed and when accepted, so no step ever waits for a check that cannot run
    const proposed = await run.proposeChange({ yaml: CHECKED, summary: "ask for a plan" });
    expect(proposed).toMatchObject({ ok: false, code: "PIPELINE_INVALID" });
    for (const source of ["file", "proposal"] as const) {
      const accepted = await run.acceptChange({ source, text: CHECKED });
      expect(accepted.ok).toBe(false);
      if (!accepted.ok) expect(accepted.error.message).toContain('unknown check kind "attachment"');
    }
    expect((await run.state()).specHash).toBe((await run.pinnedPipeline()).hash);
    // and the project's host does not list such a pipeline as one it can start
    await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
    await writeFile(join(dir, ".kodel", "pipelines", "checked.yaml"), CHECKED);
    const project = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      integrityDir: join(tmp, "integrity"),
      engine: { registry: defaultRegistry() },
    });
    const listed = await project.list();
    expect(listed.pipelines).toEqual([]);
    expect(listed.problems[0]?.message).toContain('unknown check kind "attachment"');
    expect(await project.resolve("checked")).toBeUndefined();
    // the local host as it is built by default has the kind
    const withIt = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      integrityDir: join(tmp, "integrity"),
    });
    expect((await withIt.list()).pipelines.map((p) => p.name)).toEqual(["checked"]);
    expect(withIt.registry.checkKinds()).toContain("attachment");
  });

  test("t45_unknown_check_kind_in_a_kept_copy_says_upgrade", async () => {
    // a run made by a kodel that has the kind, opened by one that does not: its kept pipeline was
    // written by a newer kodel, never "modified" and never a plain invalid pipeline
    const run = await started();
    const older = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      integrityDir: join(tmp, "integrity"),
      engine: { registry: defaultRegistry() },
    });
    const error = await refusal(older.open(run.runId));
    expect(error.code).toBe("UNSUPPORTED_FORMAT");
    expect(error.message).toContain("written by a newer kodel");
    expect(error.message).toContain("upgrade kodel");
    expect(error.message).toContain('unknown check kind "attachment"');
    // the kodel that has the kind reads it
    expect((await run.currentSpec()).nodes[0]?.checks[0]?.kind).toBe("attachment");
  });

  test("t45_format_1_refuses_a_pipeline_with_the_check", async () => {
    const GATE = "r_0mvxulus6_0m28";
    const stored = join(dir, ".kodel", "runs", GATE);
    await cp(join(FORMATS, "v1-open", GATE), stored, { recursive: true });
    for (const file of ["state.json", "meta.json"]) {
      const path = join(stored, file);
      const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (file === "state.json" || typeof value.workdir === "string") value.workdir = dir;
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
    }
    await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
    const project = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      integrityDir: join(tmp, "integrity"),
    });
    const run = (await project.open(GATE)) as LocalRun;
    expect((await run.state()).v).toBe(1);
    const pinned = await run.pinnedPipeline();
    // the run's own pipeline with the check added to its agent step
    const withCheck = pinned.yaml.replace(
      /(\n {2}- slug: impl\n {4}kind: agent\n)/,
      "$1    checks:\n      - { kind: attachment, name: plan.md }\n",
    );
    expect(withCheck).not.toBe(pinned.yaml);
    expect(() => parsePipeline(withCheck, { registry: localRegistry() })).not.toThrow();
    const journal = async () => readFile(join(stored, "journal.jsonl"), "utf8");
    const before = await journal();

    // the agent's proposal
    const proposed = await run.proposeChange({ yaml: withCheck, summary: "ask for a plan" });
    expect(proposed).toMatchObject({ ok: false, code: "UNSUPPORTED_FORMAT_FEATURE" });
    if (!proposed.ok) {
      expect(proposed.message).toContain('a pipeline with a check of kind "attachment"');
      expect(proposed.message).toContain(`kodel migrate ${GATE}`);
    }
    // a person applying it, as a proposal and as an edit of the file
    for (const source of ["proposal", "file"] as const) {
      const accepted = await run.acceptChange({ source, text: withCheck });
      expect(accepted.ok, source).toBe(false);
      if (!accepted.ok) {
        expect(accepted.error.code, source).toBe("UNSUPPORTED_FORMAT_FEATURE");
        expect(accepted.error.details, source).toMatchObject({
          how_to_upgrade: { cli: `kodel migrate ${GATE}` },
        });
      }
    }
    // nothing was written: the run is on its pipeline, in its format
    expect((await run.state()).specHash).toBe(pinned.hash);
    expect((await journal()).replace(before, "")).not.toContain("pipeline_accepted");
  });
});
