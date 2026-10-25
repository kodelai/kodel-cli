import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChoiceNeeded, PipelineService } from "@kodel-ai/pipeline-core";
import { FileStore, LocalPipelineHost } from "../src";

// The test ids are a placeholder until the decision log gives this change one (see the plan).

const pipeline = (name: string, check = "node -e 0") =>
  [
    `name: ${name}`,
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    "    prompt: write it",
    "    checks:",
    `      - { kind: command, command: '${check}' }`,
    "",
  ].join("\n");

const FILE = ".kodel/pipelines/demo.yaml";
const V1 = pipeline("demo");
const V2 = pipeline("demo", "node -e 1");

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });

async function makeRepo(config: string): Promise<void> {
  dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-proposals-")));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, FILE), V1);
  await writeFile(join(dir, ".kodel", "config.yaml"), config);
  await writeFile(join(dir, ".gitignore"), ".kodel/runs\n.kodel/worktrees\n.kodel/proposals\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
}

const host = () => new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
const pipelineFiles = async () => (await readdir(join(dir, ".kodel", "pipelines"))).sort();
const propose = (yaml: string, extra: { name?: string } = {}) =>
  host().proposePipeline({ yaml, summary: "because", ...extra });

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a pipeline proposed outside a run", () => {
  beforeEach(async () => {
    await makeRepo("worktree:\n  mode: off\n");
  });

  test("tNN_a_proposal_is_kept_apart_from_the_pipelines_that_run", async () => {
    const fresh = pipeline("fresh");
    const out = await propose(fresh);
    expect(out).toMatchObject({
      ok: true,
      status: "proposed",
      proposal: { name: "fresh", kind: "new", apply: "kodel pipeline proposals apply fresh" },
    });
    expect((await host().list()).pipelines.map((p) => p.name)).toEqual(["demo"]);
    expect(await pipelineFiles()).toEqual(["demo.yaml"]);
    // a machine-written record carries its format version
    const record = JSON.parse(
      await readFile(join(dir, ".kodel", "proposals", "fresh.json"), "utf8"),
    );
    expect(record).toMatchObject({ v: 1, name: "fresh", kind: "new", yaml: fresh });
  });

  test("tNN_a_name_in_use_is_a_change_not_a_refusal", async () => {
    const out = await propose(V2);
    expect(out).toMatchObject({
      ok: true,
      proposal: { kind: "change", changes: [{ slug: "write", changes: ["checks"] }] },
    });
    const view = await host().pipelineProposal("demo");
    expect(view?.record.base_hash).toBeDefined();
    expect(view?.commands).toEqual([
      { where: 'step "write", command check', command: "node -e 1", isNew: true },
    ]);
  });

  test("tNN_a_second_proposal_of_the_same_name_replaces_the_first", async () => {
    await propose(pipeline("fresh", "node -e 1"));
    await propose(pipeline("fresh", "node -e 2"));
    const waiting = await host().pipelineProposals();
    expect(waiting.map((r) => r.yaml)).toEqual([pipeline("fresh", "node -e 2")]);
  });

  test("tNN_a_proposal_can_be_taken_back_by_its_name", async () => {
    await propose(pipeline("fresh"));
    expect(await propose("", { name: "fresh" })).toMatchObject({ ok: true, status: "withdrawn" });
    expect(await propose("", { name: "fresh" })).toMatchObject({ ok: true, status: "none" });
    expect(await propose("")).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
  });

  test("tNN_text_that_cannot_be_trusted_is_refused", async () => {
    const secret = pipeline(
      "fresh",
      "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' x",
    );
    expect(await propose(secret)).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    // U+202E reorders what a person reads
    const hidden = `${pipeline("fresh")}# ‮evil\n`;
    const out = await propose(hidden);
    expect(out).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(!out.ok && out.message).toContain("U+202E");
    expect(await propose("name: [")).toMatchObject({ ok: false, code: "PIPELINE_INVALID" });
    expect(await propose(pipeline("Has Space"))).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENTS",
    });
    expect(await propose(pipeline("fresh"), { name: "other" })).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENTS",
    });
    expect(await host().pipelineProposals()).toEqual([]);
  });

  test("tNN_a_change_that_differs_in_nothing_is_refused", async () => {
    expect(await propose(`# a comment\n${V1}`)).toMatchObject({
      ok: false,
      code: "PIPELINE_CHANGE_REFUSED",
    });
  });

  test("tNN_a_stem_taken_by_a_file_that_is_not_that_pipeline_is_refused", async () => {
    await writeFile(join(dir, ".kodel", "pipelines", "broken.yaml"), "name: [");
    await writeFile(join(dir, ".kodel", "pipelines", "other.yaml"), pipeline("something"));
    for (const name of ["broken", "other"]) {
      expect(await propose(pipeline(name))).toMatchObject({
        ok: false,
        code: "PIPELINE_CHANGE_REFUSED",
      });
    }
  });

  test("tNN_more_than_ten_waiting_proposals_are_refused", async () => {
    for (let i = 1; i <= 10; i++) expect((await propose(pipeline(`p${i}`))).ok).toBe(true);
    expect(await propose(pipeline("p11"))).toMatchObject({
      ok: false,
      code: "PIPELINE_CHANGE_REFUSED",
    });
    // one that waits can still be replaced
    expect((await propose(pipeline("p3", "node -e 3"))).ok).toBe(true);
  });

  test("tNN_resolve_without_a_run_returns_the_text_and_its_hash", async () => {
    const svc = new PipelineService(host());
    const found = await svc.resolve({ pipeline: "demo" });
    expect(found).toMatchObject({ ok: true, yaml: V1 });
    const again = await svc.proposeChange({ pipeline: V2, summary: "s" });
    expect(again).toMatchObject({
      ok: true,
      status: "proposed",
      pipeline_proposal: { kind: "change" },
    });
    expect(found.ok && found.version).toBe(
      (await host().pipelineProposal("demo"))?.record.base_hash,
    );
  });
});

describe("accepting a proposal", () => {
  beforeEach(async () => {
    await makeRepo("worktree:\n  mode: off\n");
  });

  test("tNN_accepting_a_new_pipeline_writes_the_file_and_it_can_be_started", async () => {
    const fresh = pipeline("fresh");
    await propose(fresh);
    const view = await host().pipelineProposal("fresh");
    const done = await host().acceptPipelineProposal("fresh", view?.hash ?? "");
    expect(done).toMatchObject({ ok: true, kind: "new" });
    expect(await readFile(join(dir, ".kodel/pipelines/fresh.yaml"), "utf8")).toBe(fresh);
    expect(await host().pipelineProposals()).toEqual([]);
    const started = await host().start({ pipeline: "fresh", task: "t", restart: false });
    expect(started.status).toBe("started");
  });

  test("tNN_accepting_a_new_pipeline_works_in_a_project_with_no_pipelines_folder", async () => {
    await rm(join(dir, ".kodel", "pipelines"), { recursive: true });
    await propose(pipeline("fresh"));
    const view = await host().pipelineProposal("fresh");
    expect(await host().acceptPipelineProposal("fresh", view?.hash ?? "")).toMatchObject({
      ok: true,
    });
    expect(await pipelineFiles()).toEqual(["fresh.yaml"]);
  });

  test("tNN_accepting_a_change_replaces_the_existing_file", async () => {
    await propose(V2);
    const view = await host().pipelineProposal("demo");
    expect(await host().acceptPipelineProposal("demo", view?.hash ?? "")).toMatchObject({
      ok: true,
      kind: "change",
    });
    expect(await readFile(join(dir, FILE), "utf8")).toBe(V2);
    expect(await pipelineFiles()).toEqual(["demo.yaml"]);
  });

  test("tNN_accepting_refuses_when_the_text_moved", async () => {
    await propose(pipeline("fresh"));
    const shown = await host().pipelineProposal("fresh");
    await propose(pipeline("fresh", "node -e 9"));
    const done = await host().acceptPipelineProposal("fresh", shown?.hash ?? "");
    expect(done).toMatchObject({ ok: false });
    expect(!done.ok && done.message).toContain("modified while you were looking");
    expect(await pipelineFiles()).toEqual(["demo.yaml"]);
  });

  test("tNN_accepting_a_change_refuses_when_the_file_moved_since", async () => {
    await propose(V2);
    await writeFile(join(dir, FILE), `# edited by hand\n${V1}`);
    const view = await host().pipelineProposal("demo");
    expect(view?.refused).toContain("changed after this was proposed");
    const done = await host().acceptPipelineProposal("demo", view?.hash ?? "");
    expect(done).toMatchObject({ ok: false });
    expect(await readFile(join(dir, FILE), "utf8")).toBe(`# edited by hand\n${V1}`);
  });

  test("tNN_accepting_a_new_pipeline_refuses_when_the_name_was_taken_meanwhile", async () => {
    await propose(pipeline("fresh"));
    await writeFile(join(dir, ".kodel/pipelines/fresh.yaml"), pipeline("fresh", "node -e 7"));
    const view = await host().pipelineProposal("fresh");
    const done = await host().acceptPipelineProposal("fresh", view?.hash ?? "");
    expect(done).toMatchObject({ ok: false });
    expect(await readFile(join(dir, ".kodel/pipelines/fresh.yaml"), "utf8")).toBe(
      pipeline("fresh", "node -e 7"),
    );
  });

  test("tNN_a_proposal_can_be_dropped_and_a_name_that_is_not_a_file_name_reaches_no_path", async () => {
    await propose(pipeline("fresh"));
    expect(await host().discardPipelineProposal("fresh")).toBe(true);
    expect(await host().discardPipelineProposal("fresh")).toBe(false);
    await expect(host().pipelineProposal("../runs/x")).rejects.toThrow("cannot be a file name");
  });
});

describe("an accepted change and the runs of that pipeline", () => {
  const accept = async (yaml: string) => {
    await propose(yaml);
    const view = await host().pipelineProposal("demo");
    expect(await host().acceptPipelineProposal("demo", view?.hash ?? "")).toMatchObject({
      ok: true,
    });
  };

  test("tNN_an_accepted_change_does_not_reach_a_run_in_a_worktree", async () => {
    await makeRepo("worktree:\n  mode: auto\n");
    const h = host();
    const { run } = await h.start({ pipeline: "demo", task: "t", restart: false });
    const before = (await run.state()).specHash;
    await accept(V2);
    const opened = await host().open(run.runId);
    expect(await opened?.pendingChange()).toBeUndefined();
    expect((await opened?.state())?.specHash).toBe(before);
  });

  test("tNN_an_accepted_change_is_noticed_by_a_run_in_the_repository", async () => {
    await makeRepo("worktree:\n  mode: off\n");
    const { run } = await host().start({ pipeline: "demo", task: "t", restart: false });
    await accept(V2);
    const pending = await (await host().open(run.runId))?.pendingChange();
    expect(pending?.info.source).toBe("file");
  });

  test("tNN_start_asks_which_version_after_an_accepted_change", async () => {
    await makeRepo("worktree:\n  mode: auto\n");
    await accept(V2);
    await expect(
      host().start({ pipeline: "demo", task: "a new task", restart: false }),
    ).rejects.toBeInstanceOf(ChoiceNeeded);
  });
});

describe("a record that cannot be trusted", () => {
  beforeEach(async () => {
    await makeRepo("worktree:\n  mode: off\n");
    await mkdir(join(dir, ".kodel", "proposals"), { recursive: true });
  });

  const whole = {
    v: 1,
    name: "fresh",
    kind: "new",
    yaml: pipeline("fresh"),
    summary: "s",
    proposed_at: 1,
  };
  const plant = (record: object) =>
    writeFile(join(dir, ".kodel", "proposals", "fresh.json"), JSON.stringify(record));
  const written = () => readdir(join(dir, ".kodel", "pipelines"));

  test("tNN_text_that_is_not_a_pipeline_is_shown_as_refused_and_can_still_be_dropped", async () => {
    await plant({ ...whole, yaml: "name: [" });
    const view = await host().pipelineProposal("fresh");
    expect(view?.spec).toBeUndefined();
    expect(view?.refused).toContain("not a pipeline this kodel reads");
    expect(await host().acceptPipelineProposal("fresh", view?.hash ?? "")).toMatchObject({
      ok: false,
    });
    expect(await written()).toEqual(["demo.yaml"]);
    expect(await host().hasPipelineProposal("fresh")).toBe(true);
    expect(await host().discardPipelineProposal("fresh")).toBe(true);
  });

  test("tNN_a_character_the_person_cannot_see_is_refused_on_accept_too", async () => {
    // put there by some other route than proposePipeline, which would have refused it
    await plant({ ...whole, yaml: `${whole.yaml}# \u202Eevil\n` });
    const view = await host().pipelineProposal("fresh");
    expect(view?.refused).toContain("U+202E");
    expect(await host().acceptPipelineProposal("fresh", view?.hash ?? "")).toMatchObject({
      ok: false,
    });
    expect(await written()).toEqual(["demo.yaml"]);
  });

  test("tNN_a_record_that_is_not_whole_is_not_read_but_can_be_dropped", async () => {
    await plant({ ...whole, kind: "change" }); // a change with no base hash
    expect(await host().pipelineProposal("fresh")).toBeUndefined();
    expect(await host().pipelineProposals()).toEqual([]);
    expect(await host().hasPipelineProposal("fresh")).toBe(true);
    expect(await host().discardPipelineProposal("fresh")).toBe(true);
    await plant({ ...whole, name: "other" }); // not the name it is filed under
    expect(await host().pipelineProposal("fresh")).toBeUndefined();
  });

  test("tNN_a_record_whose_text_is_another_pipeline_is_refused", async () => {
    await plant({ ...whole, yaml: pipeline("other") });
    const view = await host().pipelineProposal("fresh");
    expect(view?.refused).toContain('named "other", not "fresh"');
  });

  test("tNN_a_file_that_is_not_json_is_not_a_record_and_can_be_dropped", async () => {
    await writeFile(join(dir, ".kodel", "proposals", "fresh.json"), "{ not json");
    expect(await host().pipelineProposal("fresh")).toBeUndefined();
    expect(await host().pipelineProposals()).toEqual([]);
    expect(await host().hasPipelineProposal("fresh")).toBe(true);
    expect(await host().discardPipelineProposal("fresh")).toBe(true);
  });

  test("tNN_stems_are_compared_without_regard_to_case", async () => {
    await writeFile(join(dir, ".kodel", "pipelines", "Foo.yaml"), "name: [");
    expect(await propose(pipeline("foo"))).toMatchObject({
      ok: false,
      code: "PIPELINE_CHANGE_REFUSED",
    });
  });

  test("tNN_a_new_file_is_created_exclusively_and_never_replaces_one", async () => {
    const store = new FileStore({ root: join(dir, ".kodel") });
    const path = join(dir, ".kodel", "pipelines", "exclusive.yaml");
    expect(await store.createFile(path, "first")).toBe(true);
    expect(await store.createFile(path, "second")).toBe(false);
    expect(await readFile(path, "utf8")).toBe("first");
    expect((await written()).sort()).toEqual(["demo.yaml", "exclusive.yaml"]); // no temporary file is left
  });
});
