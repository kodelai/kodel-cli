import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultHistory,
  defaultRegistry,
  type JournalRecord,
  type NodeHandler,
  type PipelineSpec,
  parsePipeline,
  type RunEvent,
  type RunTaskLink,
} from "@kodel-ai/pipeline-core";
import { z } from "zod";
import { GitSnapshotter, LocalHost, type LocalRun, loadConfig } from "../src";

// git is slow to start on some systems, and these tests start it many times
setDefaultTimeout(60_000);

// Tests of TASK-36TW added after the second review: the seal, the races around it, a kind of node
// that is not `agent`, and what happens when `apply` throws.

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-seal-")));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(join(dir, "base.txt"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
});
const started: LocalRun[] = [];
afterEach(async () => {
  // A run that ended started a job in the background with git working in `dir`, and a folder that a
  // program is using cannot be removed on Windows.
  await Promise.all(started.splice(0).map((run) => run.settle().catch(() => undefined)));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const write = async (path: string, content: string) => {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
};
const chain = (nodes: string[], registry = defaultRegistry(), kind = "agent"): PipelineSpec =>
  parsePipeline(
    [
      "name: seal",
      "nodes:",
      ...nodes.flatMap((slug) => [`  - slug: ${slug}`, `    kind: ${kind}`, "    prompt: do it"]),
      "edges:",
      ...nodes.slice(1).map((slug, i) => `  - { from: ${nodes[i]}, to: ${slug} }`),
      "",
    ].join("\n"),
    { registry },
  );
async function begin(spec: PipelineSpec, over: Record<string, unknown> = {}, task = "t") {
  const host = new LocalHost(spec, { root: dir, heartbeatMs: 0, ...over });
  const { run } = await host.start(task, { history: defaultHistory() });
  started.push(run);
  return { host, run };
}
const records = async (host: LocalHost, run: LocalRun, event: string) =>
  (await host.store.readJournal(run.runId)).filter((r: JournalRecord) => r.event === event);
const folder = (host: LocalHost, run: LocalRun) => join(host.store.runDir(run.runId), "changes");

class Gated extends GitSnapshotter {
  calls = 0;
  gate: { on: number; wait: Promise<void> } | undefined;
  override async snapshot(deadline?: Parameters<GitSnapshotter["snapshot"]>[0]) {
    this.calls += 1;
    if (this.gate?.on === this.calls) await this.gate.wait;
    return super.snapshot(deadline);
  }
}

describe("the seal of a finished run", () => {
  test("t36tw_changes_recorded_is_not_written_over_a_changed_journal", async () => {
    const fake = new Gated(dir);
    const { host, run } = await begin(chain(["a"]), { snapshotter: fake });
    let release!: () => void;
    fake.gate = { on: 3, wait: new Promise<void>((r) => (release = r)) };
    await run.completeStep("a", 1); // the run ends and is sealed; the end tree is being read
    expect(await run.sealStatus()).toBe("sealed");
    // During the snapshot window something is written into the journal of the finished run.
    await appendFile(join(host.store.runDir(run.runId), "journal.jsonl"), '{"event":"forged"}\n');
    release();
    await run.settle();
    // The note was not written, so the change is still a change, and no patch is left lying about.
    expect(await run.sealStatus()).toBe("modified");
    expect(await records(host, run, "changes_recorded")).toHaveLength(0);
    expect(existsSync(join(folder(host, run), "run.patch"))).toBe(false);
    // and the answer that says the run is done does not wait for a note that will never come
    await expect(run.nextStep()).rejects.toThrow("changed afterwards");
  });

  test("t36tw_end_note_and_task_note_do_not_race_into_a_lost_patch", async () => {
    // The task's note and the patch's note are written at the same moment, each in three steps
    // (state, journal, seal); a look at the seal between the steps is not a change.
    const link: RunTaskLink = {
      mode: "auto",
      prepare: async (typed) => ({ key: typed, restarting: false }),
      begin: async () => ({}),
      end: async () => ({ what: "closed" }),
    };
    for (let i = 0; i < 12; i++) {
      const host = new LocalHost(chain(["a"]), { root: dir, heartbeatMs: 0, runTaskLink: link });
      // a journal that is slow to read, as a long one or a slow disk is
      const read = host.store.readJournal.bind(host.store);
      host.store.readJournal = async (id) => {
        await new Promise((resolve) => setTimeout(resolve, 3));
        return read(id);
      };
      const { run } = await host.start(`task ${i}`, {
        history: defaultHistory(),
        taskKey: `K-${i}`,
      });
      started.push(run);
      await run.completeStep("a", 1);
      await run.settle();
      const events = (await host.store.readJournal(run.runId)).map((r: JournalRecord) => r.event);
      expect({ i, events: events.filter((e) => e === "changes_recorded").length }).toEqual({
        i,
        events: 1,
      });
      expect(existsSync(join(folder(host, run), "run.patch"))).toBe(true);
    }
  });

  test("t36tw_run_patch_for_a_run_with_no_agent_node", async () => {
    const spec = parsePipeline(
      [
        "name: cmds",
        "nodes:",
        "  - slug: make",
        "    kind: command",
        // waits for the test to say go, which it does once the baseline of the run was taken
        // (right after the start: a documented limit), so the work is certainly after it
        `    command: node -e "const f=require('fs');const t=Date.now();while(!f.existsSync('go')&&Date.now()-t<30000);f.writeFileSync('made.txt','made\\n')"`,
        "  - slug: after",
        "    kind: command",
        '    command: node -e "0"',
        "edges:",
        "  - { from: make, to: after }",
        "  - { from: make, to: after, when: failed }",
        "  - { from: after, to: make, when: failed }",
        "",
      ].join("\n"),
    );
    const { host, run } = await begin(spec);
    await write("go", "go\n");
    await run.settle();
    expect((await run.state()).status).toBe("completed");
    expect(await readdir(folder(host, run))).toEqual(["run.patch"]);
    expect(await readFile(join(folder(host, run), "run.patch"), "utf8")).toContain("made.txt");
  });

  test("t36tw_next_step_during_the_end_note_is_not_a_false_alarm", async () => {
    const fake = new Gated(dir);
    const { run } = await begin(chain(["a", "b"]), { snapshotter: fake });
    await run.completeStep("a", 1);
    let release!: () => void;
    fake.gate = { on: 4, wait: new Promise<void>((r) => (release = r)) };
    await run.completeStep("b", 1);
    const looks: Promise<unknown>[] = [];
    release();
    for (let i = 0; i < 30; i++) looks.push(run.nextStep());
    // none of the looks, taken while the note rewrites the state, the journal and the seal, throws
    expect((await Promise.allSettled(looks)).filter((r) => r.status === "rejected")).toEqual([]);
    await run.settle();
    expect(await run.sealStatus()).toBe("sealed");
  });
});

describe("a kind of node other than `agent`", () => {
  test("t36tw_agent_phase_not_node_kind: a plugin kind that waits for the agent is patched", async () => {
    const scribe: NodeHandler = {
      kind: "scribe",
      shape: { prompt: z.string() },
      allowsChecks: true,
      requiresRoutes: false,
      automaticFailures: true,
      labels: () => ({ success: ["passed"], failure: [] }),
      begin: (params, render) => ({ needs: "agent", prompt: render(String(params.prompt)) }),
    };
    const registry = defaultRegistry().registerNode(scribe);
    const { host, run } = await begin(chain(["a"], registry, "scribe"), { engine: { registry } });
    await write("scribed.txt", "scribed\n");
    expect((await run.completeStep("a", 1)).ok).toBe(true);
    await run.settle();
    const [done] = await records(host, run, "agent_completed");
    expect((done?.changes as { ref: string } | undefined)?.ref).toBe("changes/a-1.patch");
    expect(await readFile(join(folder(host, run), "a-1.patch"), "utf8")).toContain("scribed.txt");
  });
});

describe("when apply throws", () => {
  type Hook = { apply(event: RunEvent, options?: { trust?: boolean }): Promise<unknown> };

  test("t36tw_complete_step_keeps_the_patch_when_apply_throws_after_the_write", async () => {
    const { host, run } = await begin(chain(["a", "b"]));
    const hook = run as unknown as Hook;
    const original = hook.apply.bind(run);
    hook.apply = async (event, options) => {
      const decision = await original(event, options);
      if (event.type === "agent_completed") throw new Error("failed after the write");
      return decision;
    };
    await write("x.txt", "x\n");
    await expect(run.completeStep("a", 1)).rejects.toThrow("after the write");
    // the journal points at the file, so it stays
    const [done] = await records(host, run, "agent_completed");
    const ref = (done?.changes as { ref: string } | undefined)?.ref ?? "";
    expect(ref).toStartWith("changes/");
    expect(existsSync(join(host.store.runDir(run.runId), ref))).toBe(true);
  });

  test("t36tw_complete_step_leaves_no_file_when_apply_throws_before_the_write", async () => {
    const { host, run } = await begin(chain(["a", "b"]));
    const hook = run as unknown as Hook;
    hook.apply = async (event) => {
      if (event.type === "agent_completed") throw new Error("lock timeout");
      throw new Error("not expected");
    };
    await write("x.txt", "x\n");
    await expect(run.completeStep("a", 1)).rejects.toThrow("lock timeout");
    expect(await readdir(folder(host, run)).catch(() => [])).toEqual([]);
  });

  test("t36tw_complete_step_leaves_no_file_when_the_state_was_changed_outside", async () => {
    const { host, run } = await begin(chain(["a", "b"]));
    const file = join(host.store.runDir(run.runId), "state.json");
    const state = JSON.parse(await readFile(file, "utf8")) as { task: string };
    state.task = "changed by hand";
    await writeFile(file, JSON.stringify(state));
    await write("x.txt", "x\n");
    // the hand-in is refused as it always was, and what was made for it is not left behind
    const decision = await run.completeStep("a", 1);
    expect(decision.ok).toBe(false);
    expect(decision.ok ? "" : decision.error.code).toBe("STATE_MODIFIED_EXTERNALLY");
    expect(await readdir(folder(host, run)).catch(() => [])).toEqual([]);
  });

  test("t36tw_same_node_race_gives_one_file_and_the_journal_points_to_it", async () => {
    const fake = new Gated(dir);
    const { host, run } = await begin(chain(["a", "b"]), { snapshotter: fake });
    let release!: () => void;
    fake.gate = { on: 2, wait: new Promise<void>((r) => (release = r)) };
    await write("x.txt", "x\n");
    const slow = run.completeStep("a", 1); // stands at its snapshot
    // until it stands there (not a guess at how long that takes)
    while (fake.calls < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    const quick = await run.completeStep("a", 1); // another session hands the same step in
    expect(quick.ok).toBe(true);
    release();
    const late = await slow; // its apply is a repeat: its file is removed
    expect(late.ok && late.noop).toBe(true);
    const files = (await readdir(folder(host, run))).filter((f) => f.endsWith(".patch"));
    expect(files).toEqual(["a-1.patch"]);
    const [done] = await records(host, run, "agent_completed");
    expect((done?.changes as { ref: string } | undefined)?.ref).toBe("changes/a-1.patch");
  });
});

describe("a repository that is gone", () => {
  test("t36tw_d5_dot_git_gone_is_recorded_at_the_hand_in_and_at_the_end", async () => {
    const { host, run } = await begin(chain(["a"]));
    await rm(join(dir, ".git"), { recursive: true, force: true });
    const decision = await run.completeStep("a", 1);
    expect(decision.ok).toBe(true);
    await run.settle();
    const [done] = await records(host, run, "agent_completed");
    expect(done?.changes).toBeUndefined();
    expect(String(done?.changes_error).length).toBeGreaterThan(0);
    const [recorded] = await records(host, run, "changes_recorded");
    expect(String(recorded?.changes_error).length).toBeGreaterThan(0);
    expect((await run.state()).status).toBe("completed");
    expect(await run.sealStatus()).toBe("sealed");
  });
});

describe("the start of the run", () => {
  test("t36tw_d4_first_patch_starts_at_run_start", async () => {
    await write("dirty.txt", "there before the run\n"); // not committed: a dirty start
    const { host, run } = await begin(chain(["a"]));
    await write("new.txt", "made by the run\n");
    await run.completeStep("a", 1);
    const body = await readFile(join(folder(host, run), "a-1.patch"), "utf8");
    expect(body).toContain("new.txt");
    expect(body).not.toContain("dirty.txt"); // a base of HEAD would have shown it
  });

  test("t36tw_d5_missing_start_tree_at_the_end_is_recorded_and_the_task_is_told", async () => {
    let told = 0;
    const link: RunTaskLink = {
      mode: "auto",
      prepare: async (typed) => ({ key: typed, restarting: false }),
      begin: async () => ({}),
      end: async () => {
        told += 1;
        return { what: "closed" };
      },
    };
    const host = new LocalHost(chain(["a"]), { root: dir, heartbeatMs: 0, runTaskLink: link });
    const { run } = await host.start("task", { history: defaultHistory(), taskKey: "K-1" });
    started.push(run);
    await writeFile(join(host.store.runDir(run.runId), "snapshots.json"), "{}"); // no start tree
    await run.completeStep("a", 1);
    await run.settle();
    const [recorded] = await records(host, run, "changes_recorded");
    expect(recorded?.changes).toBeUndefined();
    expect(String(recorded?.changes_error)).toContain("start of the run was not recorded");
    // the verdict, the seal and the tie with the task are as they were
    expect((await run.state()).status).toBe("completed");
    expect(await run.sealStatus()).toBe("sealed");
    expect(told).toBe(1);
  });

  test("t36tw_error_text_is_not_mangled_by_a_home_of_one_character", async () => {
    class Failing extends GitSnapshotter {
      calls = 0;
      override async snapshot(deadline?: Parameters<GitSnapshotter["snapshot"]>[0]) {
        this.calls += 1;
        if (this.calls === 2) throw new Error("failed in /srv/app/data and /var/lib/x");
        return super.snapshot(deadline);
      }
    }
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    try {
      process.env.HOME = "/"; // some containers
      process.env.USERPROFILE = "/";
      const { host, run } = await begin(chain(["a"]), { snapshotter: new Failing(dir) });
      await run.completeStep("a", 1);
      const [done] = await records(host, run, "agent_completed");
      expect(String(done?.changes_error)).toBe("failed in /srv/app/data and /var/lib/x");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("t36tw_error_text_hides_the_real_path_of_the_root_and_the_temporary_folder", async () => {
    class Failing extends GitSnapshotter {
      calls = 0;
      override async snapshot(deadline?: Parameters<GitSnapshotter["snapshot"]>[0]) {
        this.calls += 1;
        if (this.calls === 2) {
          throw new Error(`failed in ${await realpath(tmpdir())}/kodel-patch-x and ${dir}/y`);
        }
        return super.snapshot(deadline);
      }
    }
    const { host, run } = await begin(chain(["a"]), { snapshotter: new Failing(dir) });
    await run.completeStep("a", 1);
    const [done] = await records(host, run, "agent_completed");
    const text = String(done?.changes_error);
    expect(text).toContain("<tmp>/kodel-patch-x");
    expect(text).toContain("./y");
    expect(text).not.toContain("/private");
    expect(text).not.toContain(dir);
  });
});

describe("limits of what is kept", () => {
  test("t36tw_max_kb_has_an_upper_bound_in_the_config", async () => {
    await mkdir(join(dir, ".kodel"), { recursive: true });
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      "version: 1\nhistory: { changes: { max_kb: 9000 } }\n",
    );
    await expect(loadConfig(join(dir, ".kodel"))).rejects.toThrow(/max_kb/);
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      "version: 1\nhistory: { changes: { max_kb: 8192 } }\n",
    );
    expect((await loadConfig(join(dir, ".kodel"))).history.changes.max_kb).toBe(8192);
  });

  test("t36tw_settle_is_bounded_by_its_deadline_even_when_the_queue_is_stuck", async () => {
    const { run } = await begin(chain(["a"]));
    const hook = run as unknown as { queue: Promise<unknown> };
    const real = hook.queue;
    hook.queue = new Promise(() => undefined);
    try {
      const started = Date.now();
      await run.settle(() => 0, Date.now() + 150);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      hook.queue = real; // the cleanup after the test waits for it too
    }
  });
});
