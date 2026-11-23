/**
 * Run attachments in the gate answer (T-45): their own group beside the changed files, the cap, and
 * what the gate showed being what a later step reads.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ATTACHMENTS_SHOWN,
  type NextStep,
  NOT_SCANNED,
  parsePipeline,
} from "@kodel-ai/pipeline-core";
import { LocalHost, type LocalRun } from "../src";

let tmp: string;
let dir: string;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "kodel-attachments-gate-")));
  dir = join(tmp, "repo");
  await mkdir(dir);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function gitInit(): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
}

const yaml = (lines: string[]) => `${lines.join("\n")}\n`;

const SINGLE = yaml([
  "name: single",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: approval, kind: human, prompt: fine? }",
  "  - { slug: impl, kind: agent, prompt: build }",
  "edges:",
  "  - { from: plan, to: approval }",
  "  - { from: approval, to: impl, when: approved }",
  "  - { from: approval, to: plan, when: rejected }",
]);

/** A gate in one branch while the agent step of the other is still open. */
const FORK = yaml([
  "name: fork",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: a }",
  "  - { slug: a-gate, kind: human, prompt: a looks fine? }",
  "  - { slug: b, kind: agent, prompt: b }",
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: a-gate }",
  "  - { from: a-gate, to: merge, when: approved }",
  "  - { from: a-gate, to: a, when: rejected }",
  "  - { from: b, to: merge }",
]);

async function start(source: string): Promise<LocalRun> {
  const host = new LocalHost(parsePipeline(source), {
    root: dir,
    heartbeatMs: 0,
    integrityDir: join(tmp, "integrity"),
    source,
  });
  return (await host.start("t")).run;
}

const text = (run: LocalRun, node: string, name: string, content: string) =>
  run.writeAttachment({ node, attempt: 1, name, content });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

function gate(step: NextStep) {
  if (!("waiting" in step) || step.waiting.reason !== "gate") {
    throw new Error(`expected a gate: ${JSON.stringify(step)}`);
  }
  return step.waiting;
}

/** The single run at its gate, with a plan, a second version of it and a screenshot. */
async function atGate(): Promise<LocalRun> {
  const run = await start(SINGLE);
  await text(run, "plan", "plan.md", "one\n");
  await text(run, "plan", "plan.md", "one\ntwo\n");
  await writeFile(join(dir, "shot.png"), PNG);
  await run.writeAttachment({ node: "plan", attempt: 1, name: "shot.png", path: "shot.png" });
  await rm(join(dir, "shot.png"));
  await run.completeStep("plan", 1);
  await run.settle();
  return run;
}

describe("t45 the gate answer", () => {
  test("t45_gate_answer_lists_attachments_as_their_own_group", async () => {
    gitInit();
    const run = await atGate();
    await writeFile(join(dir, "code.txt"), "a change\n");
    const waiting = gate(await run.nextStep());
    // the project files and the attachments are two lists: neither holds the other's entries
    expect(Object.keys(waiting.changes ?? {})).toEqual(["code.txt"]);
    expect(waiting.attachments).toEqual([
      {
        name: "plan.md",
        version: 2,
        type: "text",
        bytes: 8,
        lines: 2,
        sha256: createHash("sha256").update("one\ntwo\n").digest("hex"),
        written_by: { node_slug: "plan", attempt: 1 },
        at: expect.any(Number),
      },
      {
        name: "shot.png",
        version: 1,
        type: "png",
        bytes: PNG.length,
        sha256: createHash("sha256").update(PNG).digest("hex"),
        written_by: { node_slug: "plan", attempt: 1 },
        at: expect.any(Number),
        scanned: false,
        mark: NOT_SCANNED,
      },
    ]);
    expect(waiting.attachments_omitted).toBeUndefined();
    expect(waiting.attachments_fingerprint).toBe(await run.attachmentsFingerprint());
    expect(waiting.attachments_fingerprint).toMatch(/^plan\.md@\d+;shot\.png@\d+$/);
    expect(waiting.tell_the_person).toContain("`attachments`");
    expect(waiting.tell_the_person).toContain("attachment:<name>@<version>:<line>");
    // no path of the machine goes to the agent
    expect(JSON.stringify(waiting.attachments)).not.toContain(tmp);
    // a run without attachments says nothing of them
    const bare = await start(yaml(["name: bare", ...SINGLE.split("\n").slice(1, -1)]));
    await bare.completeStep("plan", 1);
    await bare.settle();
    const plain = gate(await bare.nextStep());
    expect(plain.attachments).toBeUndefined();
    expect(plain.attachments_fingerprint).toBeUndefined();
    expect(plain.tell_the_person).not.toContain("`attachments`");
  });

  test("t45_gate_answer_without_git", async () => {
    // no repository: nothing can be said about the files, and the attachments are listed all the same
    const run = await atGate();
    const waiting = gate(await run.nextStep());
    expect(waiting.changes).toBeUndefined();
    expect(waiting.attachments?.map((a) => a.name)).toEqual(["plan.md", "shot.png"]);
    expect(waiting.attachments_fingerprint).toBeDefined();
  });

  test("t45_gate_answer_with_changes_unavailable", async () => {
    gitInit();
    const run = await atGate();
    // the record the comparison starts from is gone: the files cannot be told, the attachments can
    await writeFile(
      join(dir, ".kodel", "runs", run.runId, "snapshots.json"),
      `${JSON.stringify({ "run!": "git failed" })}\n`,
    );
    const waiting = gate(await run.nextStep());
    expect(waiting.changes_unavailable).toBeString();
    expect(waiting.changes).toBeUndefined();
    expect(waiting.attachments?.map((a) => a.name)).toEqual(["plan.md", "shot.png"]);
  });

  test("t45_gate_answer_caps_the_list", async () => {
    const run = await atGate();
    // more names than a run can hold through the tools: lines written around them (decision 2)
    const journal = join(dir, ".kodel", "runs", run.runId, "journal.jsonl");
    const lines = (await readFile(journal, "utf8")).trim().split("\n");
    const last = JSON.parse(lines.at(-1) as string) as { seq: number; v: number };
    const sha = "0".repeat(64);
    const extra = MAX_ATTACHMENTS_SHOWN + 3;
    for (let i = 1; i <= extra; i++) {
      const name = `x${String(i).padStart(2, "0")}.md`;
      await appendFile(
        journal,
        `${JSON.stringify({
          v: last.v,
          seq: last.seq + i,
          ts: 1,
          event: "attachment_written",
          node: "plan",
          attempt: 1,
          name,
          version: 1,
          ref: `attachments/${sha}-${name}`,
          type: "text",
          bytes: 1,
          sha256: sha,
          scanned: true,
        })}\n`,
      );
    }
    const waiting = gate(await run.nextStep());
    expect(waiting.attachments).toHaveLength(MAX_ATTACHMENTS_SHOWN);
    expect(waiting.attachments_omitted).toBe(extra + 2 - MAX_ATTACHMENTS_SHOWN);
    // a version whose file is not there is listed as such, never as content
    expect(waiting.attachments?.at(-1)).toMatchObject({ state: "missing" });
  });
});

describe("t45 the gate tells the agent how a comment points at an attachment", () => {
  test("t45_gate_instruction_explains_attachment_locations", async () => {
    gitInit();
    const run = await atGate();
    const waiting = gate(await run.nextStep());
    // the form a comment or a finding uses for a line of an attachment, and that it is no project file
    expect(waiting.tell_the_person).toContain("attachment:<name>@<version>:<line>");
    expect(waiting.tell_the_person).toContain("not at a project file");
    // only where there are attachments to point at
    const bare = await start(yaml(["name: bare", ...SINGLE.split("\n").slice(1, -1)]));
    await bare.completeStep("plan", 1);
    await bare.settle();
    expect(gate(await bare.nextStep()).tell_the_person).not.toContain("attachment:");
  });
});

describe("t45 the look is held under the lock", () => {
  test("t45_decision_is_held_against_the_attachments_under_the_lock", async () => {
    gitInit();
    const fork = await start(FORK);
    await fork.completeStep("plan", 1);
    await fork.settle();
    await text(fork, "a", "plan.md", "from a\n");
    await fork.completeStep("a", 1);
    await fork.settle();
    const seen = await fork.attachmentsFingerprint();
    // a sibling writes after the caller's own comparison: the decision is refused with the write
    await text(fork, "b", "plan.md", "from b\n");
    const refused = await fork.decideHuman("a-gate", "approved", undefined, undefined, {
      attachments: seen,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("INVALID_ARGUMENTS");
      expect(refused.error.message).toContain("an attachment was written");
    }
    expect((await fork.state()).active.some((v) => v.node === "a-gate")).toBe(true);
    // "none was shown" is a look too: a first attachment written since refuses the same way
    const none = await fork.decideHuman("a-gate", "approved", undefined, undefined, {
      attachments: undefined,
    });
    expect(none.ok).toBe(false);
    // the look and the write in one race: whichever order the lock gives, nothing is approved unseen
    const now = await fork.attachmentsFingerprint();
    const [decided, written] = await Promise.all([
      fork.decideHuman("a-gate", "approved", undefined, undefined, { attachments: now }),
      text(fork, "b", "notes.md", "late\n").catch(() => undefined),
    ]);
    const after = await fork.attachmentsFingerprint();
    if (decided.ok) {
      const at = (await fork.journal()).findLast((r) => r.event === "gate_decided")?.seq ?? 0;
      const records = await fork.attachmentRecords();
      expect(records.filter((r) => r.seq < at).at(-1)?.seq).toBe(Number(now?.split("@").at(-1)));
    } else {
      expect(written).toBeDefined();
      expect(after).not.toBe(now);
    }
  });
});

describe("t45 what the gate showed is what is read", () => {
  test("t45_what_the_gate_showed_is_what_is_read", async () => {
    gitInit();
    // a plain run: the version the gate listed is the one the next step reads
    const run = await atGate();
    const shown = gate(await run.nextStep()).attachments?.find((a) => a.name === "plan.md");
    await run.decideHuman("approval", "approved");
    await run.settle();
    const read = await run.readAttachment({ name: "plan.md" });
    expect(read.attachment).toMatchObject({ version: shown?.version, sha256: shown?.sha256 });
    expect(read.content).toBe("one\ntwo\n");

    // a fork: a sibling writes a newer version while the gate waits; the version the gate showed
    // is still there, under its number, with the bytes it had
    const fork = await start(FORK);
    await fork.completeStep("plan", 1);
    await fork.settle();
    await text(fork, "a", "plan.md", "from a\n");
    await fork.completeStep("a", 1);
    await fork.settle();
    // with a sibling step open the agent's answer is that step; the gate shows what `kodel gate` shows
    const first = await fork.gateAttachments("a-gate");
    const listed = first.list.find((a) => a.name === "plan.md");
    expect(listed).toMatchObject({ version: 1, node: "a" });
    expect(first.newSince).toEqual([]);
    await text(fork, "b", "plan.md", "from b\n");
    const second = await fork.gateAttachments("a-gate");
    expect(second.list[0]).toMatchObject({ version: 2, node: "b" });
    expect(second.newSince).toEqual(["plan.md"]);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    const old = await fork.readAttachment({ name: "plan.md", version: 1 });
    expect(old.attachment.sha256).toBe(listed?.sha256 as string);
    expect(old.content).toBe("from a\n");
  });

  test("t45_file_list_does_not_move", async () => {
    gitInit();
    const run = await start(SINGLE);
    await writeFile(join(dir, "code.txt"), "a change\n");
    const before = await run.changesSinceStart();
    await text(run, "plan", "plan.md", "one\n");
    await text(run, "plan", "notes.md", "n\n");
    await writeFile(join(dir, "shot.png"), PNG);
    await run.writeAttachment({ node: "plan", attempt: 1, name: "shot.png", path: "shot.png" });
    await rm(join(dir, "shot.png"));
    // writing attachments changed nothing in the list of project files
    expect(await run.changesSinceStart()).toEqual(before);
    await run.completeStep("plan", 1);
    await run.settle();
    expect(await run.changesSinceGate("approval")).toEqual({ kind: "changes", files: {} });
    expect(Object.keys(gate(await run.nextStep()).changes ?? {})).toEqual(["code.txt"]);
  });
});
