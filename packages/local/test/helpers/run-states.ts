/**
 * A project whose runs stand in the states a reader must leave alone (decision 5M9D): engine work whose
 * owner is dead, a gate, a pause, an open change of the pipeline, a fork with a claim, an open run of
 * format 1, and a run that finished for a task the engine does not close. Made with the real host; the
 * tests of the manager's reads and of `kodel mcp --read-only` look at it and compare every byte.
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunTaskLink } from "@kodel-ai/pipeline-core";
import { LocalPipelineHost } from "../../src";

const FORMATS = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "formats",
);

/** An open run of run-state format 1, at a gate (see `fixtures/formats/README.md`). */
export const V1_GATE = "r_0mvxulus6_0m28";

const GATE = [
  "name: gated",
  "nodes:",
  "  - { slug: write, kind: agent, prompt: write it }",
  "  - { slug: approve, kind: human, prompt: Looks fine? }",
  "  - { slug: ship, kind: agent, prompt: ship it }",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: ship }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

const PAUSED = [
  "name: paused",
  "nodes:",
  "  - { slug: impl, kind: agent, prompt: do it }",
  "  - slug: test",
  "    kind: command",
  '    command: node -e "process.exit(1)"',
  "    max_consecutive_failures: 1",
  "  - { slug: fix, kind: agent, prompt: fix it }",
  "edges:",
  "  - { from: impl, to: test }",
  "  - { from: test, to: fix, when: failed }",
  "  - { from: fix, to: test }",
  "",
].join("\n");

const change = (prompt: string) =>
  [
    "name: change",
    "nodes:",
    "  - { slug: write, kind: agent, prompt: write it }",
    `  - { slug: review, kind: agent, prompt: ${prompt} }`,
    "edges:",
    "  - { from: write, to: review }",
    "",
  ].join("\n");

const FORK = [
  "name: fork",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: left, kind: agent, prompt: left }",
  "  - { slug: right, kind: agent, prompt: right }",
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: left }",
  "  - { from: plan, to: right }",
  "  - { from: left, to: merge }",
  "  - { from: right, to: merge }",
  "",
].join("\n");

const ORPHAN = [
  "name: orphan",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - slug: slow",
  "    kind: command",
  '    command: node -e "setTimeout(() => {}, 60000)"',
  "    timeout: 120",
  "  - { slug: after, kind: agent, prompt: go on }",
  "edges:",
  "  - { from: plan, to: slow }",
  "  - { from: slow, to: after }",
  "  - { from: slow, to: after, when: failed }",
  "",
].join("\n");

const TASKED = [
  "name: tasked",
  "nodes:",
  "  - { slug: only, kind: agent, prompt: do it }",
  "edges: []",
  "",
].join("\n");

export const TASK_KEY = "KDL-OPEN";

/** A tie that leaves the task to the person: the engine notes the run and closes nothing. */
export const askLink: RunTaskLink = {
  mode: "ask",
  prepare: async (typed) => ({ key: typed.toUpperCase(), restarting: false }),
  begin: async () => ({}),
  end: async () => ({ what: "hinted" }),
};

export interface States {
  root: string;
  integrityDir: string;
  /** The id of the run in each state. */
  runs: {
    gate: string;
    paused: string;
    change: string;
    fork: string;
    orphan: string;
    v1: string;
    tasked: string;
  };
  /** The hash of the proposed change of the `change` run. */
  changeHash: string;
  /** A host that only looks: the owner of the orphaned work is dead for it. */
  reader(options?: { runTaskLink?: RunTaskLink }): LocalPipelineHost;
}

/** Make the project in `tmp` (an empty directory). */
export async function makeStates(tmp: string): Promise<States> {
  const root = join(tmp, "project");
  const integrityDir = join(tmp, "integrity");
  await mkdir(join(root, ".kodel", "pipelines"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  const pipelines: Record<string, string> = {
    gated: GATE,
    paused: PAUSED,
    change: change("review it"),
    fork: FORK,
    orphan: ORPHAN,
    tasked: TASKED,
  };
  for (const [name, text] of Object.entries(pipelines)) {
    await writeFile(join(root, ".kodel", "pipelines", `${name}.yaml`), text);
  }
  await writeFile(join(root, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
  await writeFile(
    join(root, ".gitignore"),
    ".kodel/runs\n.kodel/worktrees\n.kodel/proposals\n.kodel/sessions.jsonl\n",
  );
  git("add", "-A");
  git("commit", "-q", "-m", "initial");

  const writer = new LocalPipelineHost({
    root,
    heartbeatMs: 0,
    integrityDir,
    ownerId: "ghost:1",
    runTaskLink: askLink,
  });
  const start = async (pipeline: string, extra: { task_key?: string } = {}) => {
    const started = await writer.start({
      pipeline,
      task: `a task for ${pipeline}`,
      restart: false,
      ...extra,
    });
    const run = await writer.open(started.run.runId);
    if (run === undefined) throw new Error(`the run of ${pipeline} cannot be opened`);
    return run;
  };
  const must = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`the fixture state "${what}" was not reached`);
  };

  const gate = await start("gated");
  await gate.nextStep({ serve: {} });
  await gate.completeStep("write", 1, "written");
  must(
    (await gate.state()).active.some((v) => v.phase === "human"),
    "gate",
  );

  const paused = await start("paused");
  await paused.completeStep("impl", 1, "done");
  await paused.waitForRest(20_000);
  must((await paused.state()).status === "paused", "paused");

  const changed = await start("change");
  const proposed = await changed.proposeChange({
    yaml: change("review it twice"),
    summary: "review twice, the first pass misses things",
  });
  must(proposed.ok && proposed.status === "proposed", "change");
  const changeHash = (await changed.pendingChange())?.hash ?? "";

  const fork = await start("fork");
  await fork.completeStep("plan", 1, "planned");
  const taken = await fork.takeStep({ node: "left", token: "token-left" });
  must(taken.status === "claimed", "fork");

  const orphan = await start("orphan");
  await orphan.completeStep("plan", 1, "planned");
  // The command is running; its owner goes away without a word, as a server that was killed.
  must(
    (await orphan.state()).active.some((v) => v.phase === "engine"),
    "orphan",
  );
  writer.stop();
  await new Promise((done) => setTimeout(done, 300));
  must(
    (await orphan.state()).active.some((v) => v.phase === "engine"),
    "orphan after stop",
  );

  const tasked = await start("tasked", { task_key: TASK_KEY });
  await tasked.completeStep("only", 1, "done");
  must((await tasked.state()).status === "completed", "tasked");
  await writer.settle(5_000);

  const v1Dir = join(root, ".kodel", "runs", V1_GATE);
  await cp(join(FORMATS, "v1-open", V1_GATE), v1Dir, { recursive: true });
  for (const file of ["state.json", "meta.json"]) {
    const path = join(v1Dir, file);
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (typeof value.workdir === "string") {
      await writeFile(path, `${JSON.stringify({ ...value, workdir: root }, null, 2)}\n`);
    }
  }

  return {
    root,
    integrityDir,
    runs: {
      gate: gate.runId,
      paused: paused.runId,
      change: changed.runId,
      fork: fork.runId,
      orphan: orphan.runId,
      v1: V1_GATE,
      tasked: tasked.runId,
    },
    changeHash,
    reader: (options = {}) =>
      new LocalPipelineHost({
        root,
        heartbeatMs: 0,
        integrityDir,
        isOwnerAlive: () => false,
        ...(options.runTaskLink === undefined ? {} : { runTaskLink: options.runTaskLink }),
      }),
  };
}

/**
 * Every file under `dir` with its bytes and modification time: what "nothing was written" means. The
 * git object store is left out: the snapshotter writes unreferenced objects there when it computes
 * what a run changed (`docs/mcp-roles.md`); refs, the index and the working tree are compared.
 */
export async function snapshotAll(dir: string, base = dir): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = path.slice(base.length);
    if (rel.endsWith("/.git/objects")) continue;
    if (entry.isDirectory()) Object.assign(found, await snapshotAll(path, base));
    else if (entry.isFile()) {
      const info = await stat(path);
      found[rel] = `${info.mtimeMs}:${(await readFile(path)).toString("base64")}`;
    }
  }
  return found;
}
