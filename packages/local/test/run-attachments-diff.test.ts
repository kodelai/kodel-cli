/**
 * The diff from one version of a text attachment to the next (T-45): made by git with nothing of the
 * repository, the user or the environment read, and the whole text when there is no git.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePipeline } from "@kodel-ai/pipeline-core";
import { diffTexts, type HostOptions, LocalHost, type LocalRun } from "../src";

let tmp: string;
let dir: string;
const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "kodel-attachments-diff-")));
  dir = join(tmp, "repo");
  await mkdir(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
});
afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
  await rm(tmp, { recursive: true, force: true });
});

function setEnv(key: string, value: string): void {
  saved[key] = process.env[key];
  process.env[key] = value;
}

const SOURCE = [
  "name: one",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "edges: []",
  "",
].join("\n");

async function started(over: Partial<HostOptions> = {}): Promise<LocalRun> {
  const host = new LocalHost(parsePipeline(SOURCE), {
    root: dir,
    heartbeatMs: 0,
    integrityDir: join(tmp, "integrity"),
    source: SOURCE,
    ...over,
  });
  return (await host.start("t")).run;
}

const text = (run: LocalRun, content: string, name = "plan.md") =>
  run.writeAttachment({ node: "plan", attempt: 1, name, content });

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("t45 the diff of two versions", () => {
  test("t45_version_diff_is_made_from_the_version_before", async () => {
    const run = await started();
    await text(run, "# Plan\n\none\ntwo\n");
    await text(run, "# Plan\n\none\n2\nthree\n");
    // the first version is the whole text, every line added
    expect(await run.attachmentDiff("plan.md", 1)).toEqual({
      text: "@@ -0,0 +1,4 @@\n+# Plan\n+\n+one\n+two\n",
      truncated: false,
    });
    // the latest, by default, is the diff from the one before it
    const latest = await run.attachmentDiff("plan.md");
    expect(latest?.text).toContain("@@ -1,4 +1,5 @@");
    expect(latest?.text).toContain("-two\n+2\n+three\n");
    expect(latest?.text).toContain(" # Plan\n");
    expect(latest).toEqual(await run.attachmentDiff("plan.md", 2));
    // no path of the machine is in it
    expect(latest?.text).not.toContain(tmp);
    expect(latest?.text).not.toContain(tmpdir());
    // nothing to show: no such name, no such version, an image
    expect(await run.attachmentDiff("nope.md")).toBeUndefined();
    expect(await run.attachmentDiff("plan.md", 3)).toBeUndefined();
    await writeFile(
      join(dir, "shot.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
    );
    await run.writeAttachment({ node: "plan", attempt: 1, name: "shot.png", path: "shot.png" });
    expect(await run.attachmentDiff("shot.png")).toBeUndefined();
    // a version whose stored file was changed is not shown; the next one is then the whole text
    const [first] = await run.listAttachments({ name: "plan.md" });
    await writeFile(
      join(dir, ".kodel", "runs", run.runId, "attachments", `${first?.sha256}-plan.md`),
      "tampered\n",
    );
    expect(await run.attachmentDiff("plan.md", 1)).toBeUndefined();
    expect((await run.attachmentDiff("plan.md", 2))?.text).toStartWith(
      "@@ -0,0 +1,5 @@\n+# Plan\n",
    );
  });

  test("t45_version_diff_is_hardened", async () => {
    // Everything an agent could use to have git run a program for it: an external diff named in the
    // environment and in the user's configuration, a text conversion named by the attributes of the
    // repository and of the run's folder, and a hook path.
    const marker = join(tmp, "ran");
    const evil = join(tmp, "evil.sh");
    await writeFile(evil, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho hijacked\n`);
    await chmod(evil, 0o755);
    const config = join(tmp, "gitconfig");
    await writeFile(
      config,
      `[diff]\n\texternal = ${evil}\n[diff "evil"]\n\ttextconv = ${evil}\n\tcommand = ${evil}\n[core]\n\tattributesFile = ${join(tmp, "attributes")}\n\thooksPath = ${tmp}\n`,
    );
    await writeFile(join(tmp, "attributes"), "* diff=evil\n");
    setEnv("GIT_CONFIG_GLOBAL", config);
    setEnv("GIT_EXTERNAL_DIFF", evil);
    setEnv("GIT_CONFIG_COUNT", "1");
    setEnv("GIT_CONFIG_KEY_0", "diff.external");
    setEnv("GIT_CONFIG_VALUE_0", evil);
    // the repository's own files
    await writeFile(join(dir, ".gitattributes"), "*.md diff=evil\n");
    execFileSync("git", ["config", "diff.evil.textconv", evil], { cwd: dir });
    execFileSync("git", ["config", "diff.external", evil], { cwd: dir });

    const run = await started();
    await text(run, "one\ntwo\n");
    await text(run, "one\n2\n");
    // and the run's folder, where the stored files are
    await writeFile(
      join(dir, ".kodel", "runs", run.runId, "attachments", ".gitattributes"),
      "* diff=evil\n",
    );
    const diff = await run.attachmentDiff("plan.md");
    expect(diff?.text).toContain("-two\n+2\n");
    expect(diff?.text).not.toContain("hijacked");
    expect(await exists(marker)).toBe(false);
    // the function itself, on two texts
    const direct = await diffTexts("a\nb\n", "a\nc\n", { name: "notes.txt" });
    expect(direct.text).toContain("-b\n+c\n");
    expect(await exists(marker)).toBe(false);
  });

  test("t45_version_diff_without_git", async () => {
    // no git on this machine: the version is shown whole, as text added
    const run = await started({ attachmentHooks: { git: join(tmp, "no-such-git") } });
    await text(run, "one\ntwo\n");
    await text(run, "one\n2\n");
    expect(await run.attachmentDiff("plan.md")).toEqual({
      text: "@@ -0,0 +1,2 @@\n+one\n+2\n",
      truncated: false,
    });
    // a git that fails is the same as none
    const failing = join(tmp, "failing-git");
    await writeFile(failing, "#!/bin/sh\nexit 3\n");
    await chmod(failing, 0o755);
    expect(await diffTexts("a\n", "b\n", { name: "x.md", git: failing })).toEqual({
      text: "@@ -0,0 +1,1 @@\n+b\n",
      truncated: false,
    });
    // the same text again is shown whole too, as unchanged lines; an empty text is nothing
    expect(await diffTexts("a\nb", "a\nb", { name: "x.md" })).toEqual({
      text: "@@ -1,2 +1,2 @@\n a\n b\n",
      truncated: false,
    });
    expect(await diffTexts(undefined, "", { name: "x.md" })).toEqual({
      text: "",
      truncated: false,
    });
  });
});
