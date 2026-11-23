/**
 * The wait command of a connection against the real host (T-47): the command an answer spells is byte
 * for byte the one the service was given, whatever the project's redaction rules match, and neither
 * the command nor the text of a waiting answer reaches a file of the run.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineService, type RedactRule, WAIT_COMMAND_MARK } from "@kodel-ai/pipeline-core";
import { LocalPipelineHost } from "../src";

// An agent step, then a gate that can send the run back: a `waiting` answer, twice.
const GATE = [
  "name: gate",
  "nodes:",
  "  - slug: work",
  "    kind: agent",
  "    prompt: work",
  "  - slug: ask",
  "    kind: human",
  "    prompt: fine?",
  "edges:",
  "  - { from: work, to: ask }",
  "  - { from: ask, to: work, when: rejected }",
  "",
].join("\n");

// A fork with a gate on one branch and agent steps on two: a `node` answer whose note names the command.
const MIXED = [
  "name: mixed",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: gate, kind: human, prompt: ok? }",
  "  - { slug: a, kind: agent, prompt: do a }",
  "  - { slug: b, kind: agent, prompt: do b }",
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: gate }",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: gate, to: merge, when: approved }",
  "  - { from: gate, to: merge, when: rejected }",
  "  - { from: a, to: merge }",
  "  - { from: b, to: merge }",
  "",
].join("\n");

/** A rule of the project that matches a part of the project's own path, and the build's file name. */
const RULES: RedactRule[] = [
  { name: "folder", pattern: /kodel-waitcmd-[A-Za-z0-9]+/g },
  { name: "file", pattern: /kodel\.js/g },
  { name: "number", pattern: /604800/g },
];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-waitcmd-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "gate.yaml"), GATE);
  await writeFile(join(dir, ".kodel", "pipelines", "mixed.yaml"), MIXED);
  // The project turned the offer off: a given command is offered all the same.
  await writeFile(
    join(dir, ".kodel", "config.yaml"),
    "worktree:\n  mode: off\nagent_hints:\n  wait: false\n",
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The command as a launcher would build it for this project: its own paths, a state dir, `{run}`. */
const template = () =>
  `env KODEL_STATE_DIR=${dir}/state /usr/bin/node ${dir}/dist/kodel.js --root ${dir} wait {run} --timeout 604800`;

const open = (waitCommand?: string) => {
  const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0, environment: {}, rules: RULES });
  const service = new PipelineService(host, {
    waitBudgetMs: 10_000,
    ...(waitCommand === undefined ? {} : { waitCommand }),
  });
  return { host, service };
};

type Answer = Record<string, unknown>;
const ok = (result: unknown): Answer => {
  const answer = result as Answer;
  if (answer.ok !== true) throw new Error(`refused: ${JSON.stringify(answer)}`);
  return answer;
};

/** Every string of an answer as one text (not JSON, so a quote of the command stays a quote). */
const strings = (value: unknown): string =>
  typeof value === "string"
    ? value
    : typeof value === "object" && value !== null
      ? Object.values(value).map(strings).join("\n")
      : "";

/** Every file of the project's data folder, as text. */
async function stored(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push({ path, text: await readFile(path, "utf8") });
    }
  };
  await walk(join(dir, ".kodel", "runs"));
  return out;
}

describe("t47 the wait command and what is kept of an answer", () => {
  test("t47_wait_command_is_not_changed_by_redaction", async () => {
    const { service } = open(template());
    // the rules do match the command: it would not survive a redaction
    for (const rule of RULES) expect(template()).toMatch(new RegExp(rule.pattern.source));

    const started = ok(await service.start({ pipeline: "gate", task: "t" }));
    const runId = String(started.run_id);
    const command = template().replace("{run}", runId);
    const done = ok(await service.completeStep({ run_id: runId, node_slug: "work", attempt: 1 }));
    const asked = ok(await service.nextStep({ run_id: runId }));
    for (const answer of [done.next, asked]) {
      const text = strings(answer);
      expect(text).toContain(`start \`${command}\` that way and end your turn`);
      expect(text).not.toContain(WAIT_COMMAND_MARK);
      expect(text).not.toContain("[REDACTED");
      expect(text).not.toContain("kodel wait");
    }

    // A step handed out beside a waiting decision: the note names the same command, and what the
    // host keeps of that answer (`served/`) holds neither the command nor a path of this machine.
    const fork = ok(await service.start({ pipeline: "mixed", task: "t" }));
    const forkRun = String(fork.run_id);
    const forkCommand = template().replace("{run}", forkRun);
    const next = ok(
      await service.completeStep({ run_id: forkRun, node_slug: "plan", attempt: 1 }),
    ).next;
    const again = ok(await service.nextStep({ run_id: forkRun }));
    for (const answer of [next, again]) {
      expect(strings(answer)).toContain(
        `start \`${forkCommand}\` in the background and end your turn`,
      );
      expect(strings(answer)).not.toContain(WAIT_COMMAND_MARK);
    }
    const files = await stored();
    expect(files.some((file) => file.path.includes(`${forkRun}/served/`))).toBe(true);
    for (const { path, text } of files) {
      expect(text, path).not.toContain("--timeout");
      expect(text, path).not.toContain("KODEL_STATE_DIR");
      expect(text, path).not.toContain(`${dir}/dist`);
    }
  }, 30_000);

  test("t47_waiting_answer_text_is_not_journaled", async () => {
    const { host, service } = open(template());
    const runId = String(ok(await service.start({ pipeline: "gate", task: "t" })).run_id);
    ok(await service.completeStep({ run_id: runId, node_slug: "work", attempt: 1 }));
    const first = ok(await service.nextStep({ run_id: runId }));
    const waiting = first.waiting as { tell_the_person: string; reason: string };
    expect(waiting.reason).toBe("gate");
    // The person sends it back, the step is done again: the second gate says the same.
    const run = await host.open(runId);
    if (!run) throw new Error("no run");
    const decided = await run.decideHuman("ask", "rejected", "once more");
    expect(decided.ok).toBe(true);
    ok(await service.completeStep({ run_id: runId, node_slug: "work", attempt: 2 }));
    const second = ok(await service.nextStep({ run_id: runId }));
    const command = template().replace("{run}", runId);
    for (const answer of [first, second]) {
      expect((answer.waiting as { tell_the_person: string }).tell_the_person).toContain(
        `start \`${command}\` that way and end your turn`,
      );
    }

    const journal = (await stored()).find((file) => file.path.endsWith("journal.jsonl"));
    if (!journal) throw new Error("no journal");
    const lines = journal.text.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(4);
    expect(lines.some((line) => line.includes('"gate_waiting"'))).toBe(true);
    for (const line of lines) {
      // no line holds what the agent was told at the wait: not the command, not its mark, not the text
      expect(line).not.toContain("--timeout");
      expect(line).not.toContain(WAIT_COMMAND_MARK);
      expect(line).not.toContain("that way and end your turn");
      expect(line).not.toContain("Never poll pipeline_next_step");
      expect(line).not.toContain(waiting.tell_the_person.slice(0, 60));
    }
  }, 30_000);

  test("t47_host_without_a_wait_command_answers_as_before", async () => {
    // The project's `agent_hints: { wait: false }` still applies to a connection with no command of its own.
    const { service } = open();
    const runId = String(ok(await service.start({ pipeline: "gate", task: "t" })).run_id);
    const done = ok(await service.completeStep({ run_id: runId, node_slug: "work", attempt: 1 }));
    expect(strings(done.next)).not.toContain("kodel wait");
    expect(strings(done.next)).not.toContain(WAIT_COMMAND_MARK);
  }, 30_000);
});
