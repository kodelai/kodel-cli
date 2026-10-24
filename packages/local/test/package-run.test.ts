import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost, type LocalRun } from "../src";

// A run of a project that is a package of a monorepo: the worktree is of the whole repository, and
// the run works in the same package folder inside it.

const PIPELINE = [
  "name: demo",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write it",
  "    checks:",
  "      - { kind: command, command: 'node -e 0' }",
  "  - slug: approve",
  "    kind: human",
  "    prompt: ok?",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

const FILE = ".kodel/pipelines/demo.yaml";
let repo: string;
let pkg: string;

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "kodel-pkgrun-")));
  pkg = join(repo, "packages", "app");
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await mkdir(join(pkg, ".kodel", "pipelines"), { recursive: true });
  await mkdir(join(repo, "packages", "other"), { recursive: true });
  await writeFile(join(pkg, FILE), PIPELINE);
  await writeFile(join(pkg, ".kodel", "config.yaml"), "");
  await writeFile(join(pkg, "index.ts"), "export {};\n");
  await writeFile(join(repo, "packages", "other", "index.ts"), "export {};\n");
  await writeFile(join(repo, ".gitignore"), ".kodel/runs\n.kodel/worktrees\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const host = () =>
  new LocalPipelineHost({
    root: pkg,
    storeRoot: join(pkg, ".kodel"),
    heartbeatMs: 0,
    worktree: { mode: "auto", dir: ".kodel/worktrees" },
  });

const worktrees = () =>
  git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;

async function startRun(h: LocalPipelineHost, task: string, cwd?: string) {
  const out = await h.start({
    pipeline: "demo",
    task,
    restart: false,
    ...(cwd === undefined ? {} : { cwd }),
  });
  return { run: (await h.open(out.run.runId)) as LocalRun, workdir: out.workdir?.path ?? "" };
}

describe("tXJPC_package_project_runs", () => {
  test("a run started from inside the package folder of a run's worktree reuses that worktree", async () => {
    const h = host();
    const first = await startRun(h, "one");
    const top = join(pkg, ".kodel", "worktrees", first.run.runId);
    expect(first.workdir).toBe(join(top, "packages", "app"));
    expect(worktrees()).toBe(2);

    const second = await startRun(h, "two", first.workdir);
    expect(second.workdir).toBe(first.workdir);
    expect(worktrees()).toBe(2);
    // The same when the caller stands at the top of that worktree.
    const third = await startRun(h, "three", top);
    expect(third.workdir).toBe(first.workdir);
    expect(worktrees()).toBe(2);
  });

  test("the pipeline file of the run is watched in the package folder of its worktree", async () => {
    const h = host();
    const { run, workdir } = await startRun(h, "watch");
    expect(await run.pendingChange()).toBeUndefined();

    // Not the main checkout's file: the run's own copy.
    await writeFile(join(pkg, FILE), PIPELINE.replace("node -e 0", "node -e 5"));
    expect(await run.pendingChange()).toBeUndefined();

    await writeFile(join(workdir, FILE), PIPELINE.replace("node -e 0", "node -e 1"));
    const found = await run.pendingChange();
    expect(found?.info.watched).toBe(FILE);
    expect(found?.info.refused).toBeUndefined();
  });

  test("the files changed since the start are the package's, not the whole repository's", async () => {
    const h = host();
    const { run, workdir } = await startRun(h, "diff");
    await writeFile(join(workdir, "note.txt"), "new\n");
    await writeFile(join(workdir, "..", "other", "index.ts"), "export const x = 1;\n");

    const report = await run.changesSinceStart();
    expect(report.kind).toBe("changes");
    const files = report.kind === "changes" ? Object.keys(report.files) : [];
    expect(files).toEqual(["note.txt"]);
  });
});
