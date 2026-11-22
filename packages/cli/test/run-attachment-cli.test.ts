/**
 * `kodel attachment ls|show` (T-45): reading a run's attachments in a plain terminal. Read-only; an
 * agent gets the facts of an image and never the path of the stored file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost, type LocalRun, resolveStoragePlace } from "@kodel-ai/local";
import { NOT_SCANNED } from "@kodel-ai/pipeline-core";
import { runCli } from "../src/cli";

const ID = "demo-aaaa1111";
let tmp: string;
let dir: string;
let base: string;

const DEMO = [
  "name: demo",
  "nodes:",
  "  - { slug: write, kind: agent, prompt: write }",
  "  - { slug: approve, kind: human, prompt: ok? }",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

async function project(config = ""): Promise<void> {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), DEMO);
  await writeFile(join(dir, ".kodel", "config.yaml"), `worktree:\n  mode: "off"\n${config}`);
  // the project is found by its committed config
  await writeFile(join(dir, ".gitignore"), ".kodel/runs/\n");
  git("add", ".");
  git("commit", "-q", "-m", "initial");
}

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "kodel-attachment-cli-")));
  dir = join(tmp, "repo");
  base = join(tmp, "home");
  await mkdir(dir);
  await mkdir(base);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface Person {
  interactive?: boolean;
  environment?: Record<string, string | undefined>;
  cwd?: string;
}

async function cliAs(person: Person, ...args: string[]) {
  let out = "";
  let err = "";
  const code = await runCli(args, {
    cwd: person.cwd ?? dir,
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    interactive: person.interactive ?? true,
    environment: person.environment ?? { KODEL_STATE_DIR: base },
    select: async () => [],
    confirm: async () => true,
  });
  return { code, out, err };
}
const cli = (...args: string[]) => cliAs({}, ...args);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5, 5]);

/** A run with two versions of a plan and a screenshot, made by a host the way the CLI builds it. */
async function runWithAttachments(home = false): Promise<LocalRun> {
  const host = new LocalPipelineHost({
    root: dir,
    heartbeatMs: 0,
    storage: await resolveStoragePlace({
      root: dir,
      dataDir: join(dir, ".kodel"),
      env: { KODEL_STATE_DIR: base },
    }),
  });
  const { run } = await host.start({ pipeline: "demo", task: home ? "home" : "t", restart: false });
  const opened = (await host.open(run.runId)) as LocalRun;
  const write = (name: string, content: string) =>
    opened.writeAttachment({ node: "write", attempt: 1, name, content });
  await write("plan.md", "first\n");
  await write("plan.md", "second \u001b[2Jline\nand a third\n");
  await writeFile(join(dir, "shot.png"), PNG);
  await opened.writeAttachment({ node: "write", attempt: 1, name: "shot.png", path: "shot.png" });
  await rm(join(dir, "shot.png"));
  await host.stop();
  return opened;
}

describe("t45 kodel attachment", () => {
  test("t45_cli_attachment_reads_only", async () => {
    await project();
    const run = await runWithAttachments();
    const before = await readFile(join(dir, ".kodel", "runs", run.runId, "journal.jsonl"), "utf8");

    const list = await cli("attachment", "ls", run.runId);
    expect(list.code).toBe(0);
    const lines = list.out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^plan\.md {2}text, 2 line\(s\), \d+ B, v2, by write, .* sha256 [0-9a-f]{12}$/,
    );
    expect(lines[1]).toContain(`shot.png  png, ${PNG.length} B, v1, by write, ${NOT_SCANNED}`);

    const versions = await cli("attachment", "ls", run.runId, "plan.md");
    expect(
      versions.out
        .trim()
        .split("\n")
        .map((l) => /, (v\d+),/.exec(l)?.[1]),
    ).toEqual(["v1", "v2"]);
    // the plural alias is the same command
    expect((await cli("attachments", "ls", run.runId)).out).toBe(list.out);

    const show = await cli("attachment", "show", run.runId, "plan.md");
    expect(show.code).toBe(0);
    // the text goes through `plain` line by line: the escape is gone, the lines are kept
    expect(show.out).toBe("second  [2Jline\nand a third\n");
    expect(show.err).toContain("plan.md  text, 2 line(s)");
    expect((await cli("attachment", "show", run.runId, "plan.md", "--version", "1")).out).toBe(
      "first\n",
    );

    // an image: a person at a terminal is told where the stored file is
    const image = await cli("attachment", "show", run.runId, "shot.png");
    expect(image.code).toBe(0);
    const path = image.out.trim();
    expect(path).toStartWith(join(dir, ".kodel", "runs", run.runId, "attachments"));
    expect(await readFile(path)).toEqual(PNG);
    expect(image.err).toContain(NOT_SCANNED);

    // nothing was written by any of it
    expect(await readFile(join(dir, ".kodel", "runs", run.runId, "journal.jsonl"), "utf8")).toBe(
      before,
    );
  });

  test("t45_cli_attachment_for_an_agent", async () => {
    await project();
    const run = await runWithAttachments();
    const agent = { environment: { KODEL_STATE_DIR: base, KODEL_ENGINE: "1" }, interactive: false };
    // read-only, so it runs for an agent; the path of a run file is not given to it
    const list = await cliAs(agent, "attachment", "ls", run.runId);
    expect(list.code).toBe(0);
    expect(list.out).toContain("shot.png");
    for (const person of [
      agent,
      { ...agent, interactive: true },
      { environment: { KODEL_STATE_DIR: base }, interactive: false },
    ]) {
      const image = await cliAs(person, "attachment", "show", run.runId, "shot.png");
      expect(image.code).toBe(0);
      expect(image.out + image.err).not.toContain(tmp);
      expect(image.out + image.err).not.toContain("attachments/");
      expect(image.err).toContain(`png, ${PNG.length} B`);
    }
    // a text is the same for everyone
    const text = await cliAs(agent, "attachment", "show", run.runId, "plan.md", "--version", "1");
    expect(text.out).toBe("first\n");
  });

  test("t45_cli_attachment_errors", async () => {
    await project();
    const run = await runWithAttachments();
    const failing: string[][] = [
      ["attachment", "ls", "r_000000000_none"],
      ["attachment", "show", "r_000000000_none", "plan.md"],
      ["attachment", "ls", run.runId, "nope.md"],
      ["attachment", "show", run.runId, "nope.md"],
      ["attachment", "show", run.runId, "../state.json"],
      ["attachment", "show", run.runId, "plan.md", "--version", "9"],
      ["attachment", "show", run.runId, "plan.md", "--version", "0"],
      ["attachment", "show", run.runId, "plan.md", "--version", "two"],
    ];
    for (const args of failing) {
      const result = await cli(...args);
      expect(result.code, args.join(" ")).not.toBe(0);
      expect(result.err.trim().length, args.join(" ")).toBeGreaterThan(0);
      expect(result.out, args.join(" ")).toBe("");
    }
    expect((await cli("attachment", "show", run.runId, "plan.md", "--version", "9")).err).toContain(
      "no version 9",
    );
    // outside a project
    const outside = join(tmp, "nowhere");
    await mkdir(outside);
    const lost = await cliAs({ cwd: outside }, "attachment", "ls", run.runId);
    expect(lost.code).not.toBe(0);
    expect(lost.err.trim().length).toBeGreaterThan(0);

    // a stored file that was changed is said so and not printed
    const folder = join(dir, ".kodel", "runs", run.runId, "attachments");
    const file = (await readdir(folder)).find((f) => f.endsWith("-shot.png")) as string;
    await writeFile(join(folder, file), "not the image\n");
    const changed = await cli("attachment", "show", run.runId, "shot.png");
    expect(changed.code).not.toBe(0);
    expect(changed.err).toContain("changed outside kodel");
    expect(changed.out).toBe("");
    expect((await cli("attachment", "ls", run.runId)).out).toContain(
      "THE STORED FILE WAS CHANGED OUTSIDE KODEL",
    );
  });

  test("t45_cli_attachment_storage_home", async () => {
    await project(`storage: home\nproject_id: ${ID}\n`);
    const run = await runWithAttachments(true);
    const list = await cli("attachment", "ls", run.runId);
    expect(list.code).toBe(0);
    expect(list.out).toContain("plan.md");
    const image = await cli("attachment", "show", run.runId, "shot.png");
    expect(image.out.trim()).toStartWith(
      join(base, "projects", ID, "runs", run.runId, "attachments"),
    );
    expect((await cli("attachment", "show", run.runId, "plan.md", "--version", "1")).out).toBe(
      "first\n",
    );
    // a run kept at home is no run of a project that keeps its history in the project
    expect(await readdir(join(dir, ".kodel"))).not.toContain("runs");
  });
});
