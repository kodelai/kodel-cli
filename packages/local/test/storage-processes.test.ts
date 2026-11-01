import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost, resolveStoragePlace } from "../src";

// Real processes and git repositories: slower than the rest on a busy machine.
setDefaultTimeout(60_000);

const ID = "demo-aaaa1111";
const CHILD = join(import.meta.dir, "helpers", "storage-child.ts");

let tmp: string;
let base: string;
let hashes: string;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "kodel-procs-")));
  base = join(tmp, "base");
  hashes = join(tmp, "hashes");
  await mkdir(base);
  await mkdir(hashes);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
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

/** A committed project whose config puts the history under the home base. */
async function clone(name: string): Promise<string> {
  const root = join(tmp, name);
  await mkdir(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await mkdir(join(root, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(root, ".kodel", "pipelines", "demo.yaml"), DEMO);
  await writeFile(
    join(root, ".kodel", "config.yaml"),
    `worktree:\n  mode: "off"\nstorage: home\nproject_id: ${ID}\n`,
  );
  git("add", ".kodel");
  git("commit", "-q", "-m", "initial");
  return root;
}

/** Start the children, let both of them get ready, then release them together. */
async function race(
  children: { args: string[] }[],
): Promise<{ lines: Record<string, unknown>[]; code: number }[]> {
  const go = join(tmp, "go");
  const procs = children.map((child, i) => {
    const ready = join(tmp, `ready-${i}`);
    return {
      ready,
      proc: Bun.spawn(
        ["bun", CHILD, ...child.args.slice(0, 4), go, ready, ...child.args.slice(4)],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, KODEL_STATE_DIR: base },
        },
      ),
    };
  });
  const deadline = Date.now() + 30_000;
  while (procs.some((p) => !existsSync(p.ready))) {
    if (Date.now() > deadline) throw new Error("the children did not get ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await writeFile(go, "go");
  return Promise.all(
    procs.map(async ({ proc }) => {
      const code = await proc.exited;
      const out = (await new Response(proc.stdout).text()).trim().split("\n").filter(Boolean);
      const err = await new Response(proc.stderr).text();
      if (code !== 0) throw new Error(`a child failed (${code}): ${err}`);
      return { lines: out.map((l) => JSON.parse(l) as Record<string, unknown>), code };
    }),
  );
}

describe("two real processes", () => {
  test("storage_two_clones_two_runs_serialised: two checkouts starting one task get a run each", async () => {
    if (process.platform === "win32") return;
    const a = await clone("clone-a");
    const b = await clone("clone-b");
    const results = await race([
      { args: ["start", a, base, hashes, "same"] },
      { args: ["start", b, base, hashes, "same"] },
    ]);
    const ids = results.map((r) => r.lines[0]?.["runId"] as string);
    expect(new Set(ids).size).toBe(2);
    for (const r of results) expect(r.lines[0]?.["status"]).toBe("started");
    // One folder per run and a listing that is the union, seen from either checkout.
    const place = await resolveStoragePlace({
      root: a,
      dataDir: join(a, ".kodel"),
      env: { KODEL_STATE_DIR: base },
    });
    expect((await readdir(place.runsRoot)).sort()).toEqual([...ids].sort());
    const host = new LocalPipelineHost({
      root: a,
      heartbeatMs: 0,
      integrityDir: hashes,
      storage: place,
    });
    expect((await host.runSummaries()).map((s) => s.meta.runId).sort()).toEqual([...ids].sort());
    // Each run belongs to its own checkout: the other one is foreign to it.
    const foreign = await Promise.all(ids.map(async (id) => (await host.open(id))?.foreignRoot()));
    expect(foreign.filter((root) => root !== undefined)).toHaveLength(1);
  });

  test("storage_concurrent_place_creation: one place made by two processes at once", async () => {
    if (process.platform === "win32") return;
    const a = await clone("clone-a");
    const b = await clone("clone-b");
    await chmod(base, 0o755); // a folder that was there before, with whatever mode its owner gave it
    const results = await race([
      { args: ["ensure", a, base, hashes] },
      { args: ["ensure", b, base, hashes] },
    ]);
    expect(results).toHaveLength(2);
    const tree = join(base, "projects", ID);
    for (const folder of [tree, join(tree, "runs")]) {
      expect(((await stat(folder)).mode & 0o777).toString(8), folder).toBe("700");
    }
    // The base existed before (it is shared with other things): it is not chmodded.
    expect(((await stat(base)).mode & 0o777).toString(8)).toBe("755");
  });
});
