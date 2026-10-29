import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultIntegrityDir,
  FileIntegrity,
  homeHashKey,
  LocalPipelineHost,
  type LocalRun,
  resolveBase,
  resolveStoragePlace,
  sha256,
} from "../src";

const ID = "demo-aaaa1111";

let dir: string;
let clone: string;
let base: string;
let hashes: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-storage-int-"));
  clone = await mkdtemp(join(tmpdir(), "kodel-storage-int-clone-"));
  base = await mkdtemp(join(tmpdir(), "kodel-storage-int-base-"));
  hashes = await mkdtemp(join(tmpdir(), "kodel-storage-int-hashes-"));
  for (const root of [dir, clone]) await project(root, `storage: home\nproject_id: ${ID}\n`);
});
afterEach(async () => {
  for (const path of [dir, clone, base, hashes]) await rm(path, { recursive: true, force: true });
});

const DEMO = [
  "name: demo",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write",
  "  - slug: approve",
  "    kind: human",
  "    prompt: ok?",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

async function project(root: string, storage: string): Promise<void> {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(root, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(root, ".kodel", "pipelines", "demo.yaml"), DEMO);
  await writeFile(join(root, ".kodel", "config.yaml"), `worktree:\n  mode: "off"\n${storage}`);
}

const env = () => ({ KODEL_STATE_DIR: base });
const tree = () => join(base, "projects", ID);
const stateOf = (run: LocalRun) => join(tree(), "runs", run.runId, "state.json");
const hashFile = (run: LocalRun, key = homeHashKey(ID), dirOfHashes = hashes) =>
  join(dirOfHashes, key, `${run.runId}.sha256`);

async function hostAt(root: string, over: Record<string, unknown> = {}) {
  return new LocalPipelineHost({
    root,
    heartbeatMs: 0,
    integrityDir: hashes,
    storage: await resolveStoragePlace({ root, dataDir: join(root, ".kodel"), env: env() }),
    ...over,
  });
}

async function startRun(h: LocalPipelineHost): Promise<LocalRun> {
  const { run } = await h.start({ pipeline: "demo", task: "t", restart: false });
  return (await h.open(run.runId)) as LocalRun;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const editState = async (path: string) => {
  const text = await readFile(path, "utf8");
  expect(text).toContain('"status": "running"');
  await writeFile(path, text.replace('"status": "running"', '"status": "paused"'));
};

/** Any call that goes through the trust check of the run, and changes nothing by itself. */
const touch = (run: LocalRun) => run.apply({ type: "tick" });

describe("integrity in home mode: adoption", () => {
  test("storage_adopt_then_edit_detected", async () => {
    const run = await startRun(await hostAt(dir));
    expect(await run.integrityStatus()).toBe("ok");
    await rm(hashFile(run));
    expect(await run.integrityStatus()).toBe("unknown");
    // First use adopts the run as it is.
    expect((await touch(run)).ok).toBe(true);
    expect(await run.integrityStatus()).toBe("ok");
    // A later edit is then caught, and the run does not go on.
    await editState(stateOf(run));
    expect(await run.integrityStatus()).toBe("modified");
    const refused = await touch(run);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("STATE_MODIFIED_EXTERNALLY");
  });

  test("storage_moved_modified_state_is_adopted", async () => {
    // A run made in `project` mode, edited, and moved by hand into the home tree: no hash is known
    // under the home key, so the edit is taken as the state (the documented trust-reset path).
    await writeFile(join(dir, ".kodel", "config.yaml"), 'worktree:\n  mode: "off"\n');
    const projectHost = await hostAt(dir, { storage: undefined });
    const old = await startRun(projectHost);
    await editState(join(dir, ".kodel", "runs", old.runId, "state.json"));
    expect(await old.integrityStatus()).toBe("modified");

    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      `worktree:\n  mode: "off"\nstorage: home\nproject_id: ${ID}\n`,
    );
    await mkdir(join(tree(), "runs"), { recursive: true });
    await rename(join(dir, ".kodel", "runs", old.runId), join(tree(), "runs", old.runId));
    const moved = (await (await hostAt(dir)).open(old.runId)) as LocalRun;
    expect(await moved.integrityStatus()).toBe("unknown");
    expect((await touch(moved)).ok).toBe(true);
    expect(await moved.integrityStatus()).toBe("ok");
  });

  test("storage_deleted_hash_then_edit_is_adopted", async () => {
    const run = await startRun(await hostAt(dir));
    await rm(hashFile(run));
    await editState(stateOf(run));
    expect(await run.integrityStatus()).toBe("unknown");
    expect((await touch(run)).ok).toBe(true);
    expect(await run.integrityStatus()).toBe("ok");
  });
});

describe("seals in home mode", () => {
  async function sealedRun(root: string) {
    const h = await hostAt(root);
    const run = await startRun(h);
    await run.cancel();
    return run;
  }

  test("storage_seal_survives_move", async () => {
    const run = await sealedRun(dir);
    expect(await run.sealStatus()).toBe("sealed");
    // The hash of the seal is kept under the project's key, next to the run's own.
    const key = homeHashKey(ID);
    const sealPath = join(tree(), "runs", run.runId, "seal.json");
    const sealText = await readFile(sealPath, "utf8");
    expect(await new FileIntegrity(hashes, dir, key).get(`${run.runId}.seal`)).toBe(
      sha256(sealText),
    );
    expect(await exists(join(hashes, key, `${run.runId}.seal.sha256`))).toBe(true);

    // Another clone of the project (another path) sees the run as sealed too.
    const other = (await (await hostAt(clone)).open(run.runId)) as LocalRun;
    expect(await other.sealStatus()).toBe("sealed");

    // A seal rewritten to match the files, but not the hash kept outside, is caught in both.
    const seal = JSON.parse(sealText) as { sealedAt: number };
    await writeFile(
      sealPath,
      `${JSON.stringify({ ...seal, sealedAt: seal.sealedAt + 1 }, null, 2)}\n`,
    );
    expect(await run.sealStatus()).toBe("modified");
    expect(await other.sealStatus()).toBe("modified");
  });
});

describe("the key and the directory of the hashes", () => {
  test("storage_shared_base_detects_edit", async () => {
    // KODEL_STATE_DIR names the hashes and the history both: they are different trees under it.
    const run = await startRun(await hostAt(dir, { integrityDir: base }));
    expect(await exists(hashFile(run, homeHashKey(ID), base))).toBe(true);
    expect(await exists(join(tree(), "runs", run.runId))).toBe(true);
    expect(await run.integrityStatus()).toBe("ok");
    await editState(stateOf(run));
    expect(await run.integrityStatus()).toBe("modified");
    const refused = await touch(run);
    expect(refused.ok).toBe(false);
  });

  test("storage_state_dir_alone_keeps_hashes", async () => {
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      'worktree:\n  mode: "off"\nstorage: project\n',
    );
    const settings = { KODEL_STATE_DIR: base };
    const place = await resolveStoragePlace({
      root: dir,
      dataDir: join(dir, ".kodel"),
      env: settings,
    });
    expect(place.mode).toBe("project");
    expect(place.hashKey).toBeUndefined();
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      integrityDir: defaultIntegrityDir(settings),
      storage: place,
    });
    const run = await startRun(host);
    // The key is what it always was: from the real path of `<root>/.kodel`.
    const key = sha256(await realpath(join(dir, ".kodel"))).slice(0, 16);
    expect(await exists(join(base, key, `${run.runId}.sha256`))).toBe(true);
    expect(await exists(join(dir, ".kodel", "runs", run.runId, "state.json"))).toBe(true);
    expect(await exists(join(base, "projects"))).toBe(false);
    expect(await run.integrityStatus()).toBe("ok");
  });

  test("storage_default_hash_dir_separate_from_history", () => {
    const home = join(tmpdir(), "some-home");
    const history = resolveBase({}, home);
    const trust = defaultIntegrityDir({}, home);
    expect(history).toBe(join(home, ".kodel"));
    expect(trust).toBe(join(home, ".local", "state", "kodel"));
    expect(trust.startsWith(history)).toBe(false);
    expect(history.startsWith(trust)).toBe(false);
    // With XDG_STATE_HOME the hashes move, the history does not.
    expect(defaultIntegrityDir({ XDG_STATE_HOME: join(home, "xdg") }, home)).toBe(
      join(home, "xdg", "kodel"),
    );
    expect(resolveBase({ XDG_STATE_HOME: join(home, "xdg") }, home)).toBe(history);
  });

  test("storage_key_matches_integrity_key", async () => {
    // Project mode: the host and a FileIntegrity made the old way agree.
    await writeFile(join(dir, ".kodel", "config.yaml"), 'worktree:\n  mode: "off"\n');
    const projectRun = await startRun(await hostAt(dir, { storage: undefined }));
    const projectState = await readFile(
      join(dir, ".kodel", "runs", projectRun.runId, "state.json"),
    );
    const old = new FileIntegrity(hashes, join(dir, ".kodel"));
    expect(await old.get(projectRun.runId)).toBe(sha256(projectState));

    // Home mode: the key is the project's id, whatever the path.
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      `worktree:\n  mode: "off"\nstorage: home\nproject_id: ${ID}\n`,
    );
    const homeRun = await startRun(await hostAt(dir));
    const homeState = await readFile(stateOf(homeRun));
    for (const root of [dir, clone, join(tmpdir(), "nowhere")]) {
      expect(await new FileIntegrity(hashes, root, homeHashKey(ID)).get(homeRun.runId)).toBe(
        sha256(homeState),
      );
    }
    // And that key is not the path-derived one.
    expect(await old.get(homeRun.runId)).toBeUndefined();
  });
});
