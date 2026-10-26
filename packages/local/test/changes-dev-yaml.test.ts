import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultHistory, parsePipeline } from "@kodel-ai/pipeline-core";
import { LocalHost, type LocalRun } from "../src";
import type { CommandResult } from "../src/command";

// Tests of TASK-36TW: the repository's own pipeline (`.kodel/pipelines/dev.yaml`), driven by a script
// in place of the agent and with its commands (tests, build, push) answered by a stub, leaves a patch
// for every handed-in agent attempt and one for the run.

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-devyaml-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await writeFile(join(dir, "README.md"), "readme\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (path: string, content: string) => {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
};
const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag} line ${i}\n`).join("");

const passing = async (): Promise<CommandResult> => ({
  exit: 0,
  timedOut: false,
  aborted: false,
  tail: "",
  truncated: false,
  durationMs: 1,
});

test("t36tw_real_dev_yaml_scripted_run_leaves_patches", async () => {
  const source = await readFile(
    new URL("../../../.kodel/pipelines/dev.yaml", import.meta.url),
    "utf8",
  );
  const task = "add the thing";
  const host = new LocalHost(parsePipeline(source), {
    root: dir,
    heartbeatMs: 0,
    runCommand: passing,
  });
  const started = await host.start(task, { history: defaultHistory() });
  const live: LocalRun = started.run;
  // The pipeline asks for `docs/plans/{{task.slug}}.md`, and that slug is written with underscores.
  const plan = "docs/plans/add_the_thing.md";
  const done = async (node: string, attempt = 1) => {
    const decision = await live.completeStep(node, attempt);
    expect(decision.ok ? "ok" : `${decision.error.code}: ${decision.error.message}`).toBe("ok");
    await live.settle();
  };

  await write(plan, lines(12, "plan"));
  await done("plan");
  await live.reportResult("plan-critique", 1, { rows: [], completeness: "complete" });
  await done("plan-critique");
  await write(plan, lines(12, "plan") + lines(12, "revised"));
  await done("plan-revise");
  await live.decideHuman("plan-approval", "approved");
  await live.settle();
  await write("packages/thing/src/index.ts", "export const thing = 1;\n");
  await done("impl");
  // verify, test and build ran (the stub passed them); the review reports nothing
  await live.reportResult("review", 1, { rows: [], completeness: "complete" });
  await done("review");
  await live.decideHuman("final-approval", "approved");
  await live.settle();
  await done("publish");
  await live.waitForRest(30_000);

  const state = await live.state();
  expect(state.status).toBe("completed");
  const folder = join(host.store.runDir(live.runId), "changes");
  const files = (await readdir(folder)).sort();
  expect(files).toEqual([
    "impl-1.patch",
    "plan-1.patch",
    "plan-critique-1.patch",
    "plan-revise-1.patch",
    "publish-1.patch",
    "review-1.patch",
    "run.patch",
  ]);
  expect(await readFile(join(folder, "plan-1.patch"), "utf8")).toContain(plan);
  expect(await readFile(join(folder, "impl-1.patch"), "utf8")).toContain(
    "packages/thing/src/index.ts",
  );
  const whole = await readFile(join(folder, "run.patch"), "utf8");
  expect(whole).toContain(plan);
  expect(whole).toContain("packages/thing/src/index.ts");
  // The patch of a step that changed nothing is a header and nothing else.
  expect(await readFile(join(folder, "review-1.patch"), "utf8")).toBe("# kodel-patch v1\n");
});
