/**
 * Task links in the files of the `local` adapter (TASK-9RZD, T-45): where a link is written, what a
 * hand-edited or merged file does, and that the two keys are optional keys of format 1.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KodelError, needsApproval, type Task, TaskService } from "@kodel-ai/pipeline-core";
import { buildTaskTools, invokeTaskTool } from "@kodel-ai/pipeline-core/mcp";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { LocalTaskAdapter, TASKS_DIR } from "../src";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures", "task-formats", "v1");
const o = () => ({ signal: new AbortController().signal });
const ALL = { state: ["todo", "progress", "done"] as ("todo" | "progress" | "done")[], limit: 200 };

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kodel-tasklinks-"));
  await mkdir(join(root, TASKS_DIR), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function adapter(prefix = "KDL") {
  let now = Date.UTC(2026, 10, 22, 9);
  return new LocalTaskAdapter({
    storeRoot: root,
    prefix,
    clock: () => {
      now += 1000;
      return now;
    },
    random: Math.random,
  });
}

const fileOf = (key: string) => join(root, TASKS_DIR, `${key}.yaml`);
const textOf = (key: string) => readFile(fileOf(key), "utf8");
const onDisk = async (key: string) => parse(await textOf(key)) as Record<string, unknown>;

/** A task file as a person or a merge could have left it. */
async function put(key: string, extra: Record<string, unknown> = {}): Promise<void> {
  const record = {
    v: 1,
    id: key.slice(key.lastIndexOf("-") + 1),
    key,
    title: `Task ${key}`,
    priority: "normal",
    status: "todo",
    created_at: "2026-11-20T10:00:00.000Z",
    updated_at: "2026-11-20T10:00:00.000Z",
    ...extra,
  };
  await writeFile(fileOf(key), stringify(record));
}

const refused = async (work: Promise<unknown>): Promise<KodelError> => {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(KodelError);
    return error as KodelError;
  }
  throw new Error("did not fail");
};

const get = async (a: LocalTaskAdapter, key: string): Promise<Task> => {
  const found = await a.get(key, o());
  if (!found) throw new Error(`no task ${key}`);
  return found.task;
};

describe("t45 where a conflict is written", () => {
  test("t45_conflicts_are_symmetric_whichever_file_holds_them", async () => {
    const a = adapter();
    const first = (await a.create({ title: "First" }, o())).key;
    const second = (await a.create({ title: "Second" }, o())).key;

    // Written to the file of the task it was set on, read on both.
    await a.update(first, { add_conflicts_with: [second] }, o());
    expect((await onDisk(first)).conflicts_with).toEqual([second]);
    expect("conflicts_with" in (await onDisk(second))).toBe(false);
    expect((await get(a, second)).conflicts_with).toEqual([first]);

    // Removed on the other task: the file that holds it is cleared.
    const removed = await a.update(second, { remove_conflicts_with: [first] }, o());
    expect(removed?.task.conflicts_with).toBeUndefined();
    expect("conflicts_with" in (await onDisk(first))).toBe(false);
    expect((await get(a, first)).conflicts_with).toBeUndefined();

    // Adding a conflict the other file already holds writes no second copy.
    await a.update(first, { add_conflicts_with: [second] }, o());
    await a.update(second, { add_conflicts_with: [first] }, o());
    expect("conflicts_with" in (await onDisk(second))).toBe(false);

    // Files that name each other, and a file that names a task twice, read as one conflict each.
    await put("KDL-2222", { conflicts_with: ["KDL-3333", "KDL-3333"] });
    await put("KDL-3333", { conflicts_with: ["KDL-2222"] });
    expect((await get(a, "KDL-2222")).conflicts_with).toEqual(["KDL-3333"]);
    expect((await get(a, "KDL-3333")).conflicts_with).toEqual(["KDL-2222"]);
    // Removed from every file that holds it.
    await a.update("KDL-2222", { clear: ["conflicts_with"] }, o());
    expect("conflicts_with" in (await onDisk("KDL-2222"))).toBe(false);
    expect("conflicts_with" in (await onDisk("KDL-3333"))).toBe(false);
  });

  test("t45_half_removed_conflict_stays_in_force", async () => {
    const a = adapter();
    for (const layout of ["both files", "the other file only"] as const) {
      const t = `KDL-${layout === "both files" ? "4444" : "6666"}`;
      const u = `KDL-${layout === "both files" ? "5555" : "7777"}`;
      await put(t, layout === "both files" ? { conflicts_with: [u] } : {});
      await put(u, { conflicts_with: [t] });
      // Another writer holds the other task: its file cannot be written now.
      await writeFile(`${fileOf(u)}.lock`, "held");
      const failed = await refused(a.update(t, { remove_conflicts_with: [u] }, o()));
      expect(failed.code).toBe("TASK_ADAPTER_FAILED");
      // Half removed: the conflict is still read on both tasks.
      expect((await get(a, t)).conflicts_with).toEqual([u]);
      expect((await get(a, u)).conflicts_with).toEqual([t]);
      // A repeat of the call finishes it.
      await rm(`${fileOf(u)}.lock`);
      const done = await a.update(t, { remove_conflicts_with: [u] }, o());
      expect(done?.task.conflicts_with).toBeUndefined();
      expect("conflicts_with" in (await onDisk(t))).toBe(false);
      expect("conflicts_with" in (await onDisk(u))).toBe(false);
    }
  }, 20_000);

  test("t45_link_change_does_not_touch_the_approval_mark", async () => {
    const a = adapter();
    const service = new TaskService(a);
    const tools = buildTaskTools(a.capabilities);
    const call = (name: string, input: unknown) => invokeTaskTool(service, tools, name, input);
    // A person's tasks; the conflict of the first two is held in the second file.
    const first = (await a.create({ title: "First" }, o())).key;
    const second = (await a.create({ title: "Second", conflicts_with: [first] }, o())).key;
    const third = (await a.create({ title: "Third" }, o())).key;

    for (const patch of [
      { add_depends_on: [third] },
      { add_conflicts_with: [third] },
      { remove_conflicts_with: [second] },
      { remove_depends_on: [third] },
      { depends_on: [second, third] },
      { clear: ["depends_on", "conflicts_with"] },
    ]) {
      expect((await call("task_update", { key: first, ...patch })).ok).toBe(true);
      for (const key of [first, second, third]) {
        const file = await onDisk(key);
        expect({ key, patch, mark: file.agent_edited_at }).toEqual({ key, patch, mark: undefined });
        expect(needsApproval(await get(a, key))).toBe(false);
      }
    }
    // An agent that closes a dependency is another matter: that is the status, and it is marked.
    await call("task_update", { key: first, add_depends_on: [third] });
    await call("task_update", { key: third, status: "done" });
    expect(typeof (await onDisk(third)).agent_edited_at).toBe("string");
    const waits = await get(a, first);
    expect(waits.dependencies).toEqual([{ key: third, state: "done", needs_approval: true }]);
    expect(waits.blocked_by).toEqual([third]);
    const closed = await get(a, third);
    await a.approve(third, closed.updated_at, o());
    expect((await get(a, first)).blocked_by).toBeUndefined();
    // A declined dependency releases like a done one, and says what it is.
    await a.update(third, { status: "declined" }, o());
    expect((await get(a, first)).dependencies).toEqual([{ key: third, state: "declined" }]);
  });
});

describe("t45 the two keys in format 1", () => {
  test("t45_task_file_links_round_trip", async () => {
    const files = [
      ["person-before-marks.yaml", "TASK-BBBB"],
      ["agent-with-marks.yaml", "TASK-MMMM"],
      ["with-links.yaml", "TASK-KKKK"],
    ] as const;
    for (const [name, key] of files) await copyFile(join(FIXTURES, name), fileOf(key));
    const a = adapter("TASK");

    const linked = await get(a, "TASK-KKKK");
    expect(linked.depends_on).toEqual(["TASK-DDDD"]);
    expect(linked.dependencies).toEqual([{ key: "TASK-DDDD", state: "missing" }]);
    expect(linked.blocked_by).toEqual(["TASK-DDDD"]);
    expect(linked.conflicts_with).toEqual(["TASK-CCCC"]);
    for (const key of ["TASK-BBBB", "TASK-MMMM"]) {
      const old = await get(a, key);
      for (const field of [
        "depends_on",
        "dependencies",
        "blocked_by",
        "blocks",
        "conflicts_with",
      ]) {
        expect(field in old).toBe(false);
      }
    }

    // Written back: every key as it was and in the same place, and no link key where there was none.
    for (const [name, key] of files) {
      const before = await readFile(join(FIXTURES, name), "utf8");
      await a.update(key, { comment: "read back" }, o());
      const after = await textOf(key);
      const was = parse(before) as Record<string, unknown>;
      const now = parse(after) as Record<string, unknown>;
      const { comments: _c1, updated_at: _u1, ...keptBefore } = was;
      const { comments: _c2, updated_at: _u2, ...keptAfter } = now;
      expect(keptAfter).toEqual(keptBefore);
      expect(Object.keys(now).filter((k) => k !== "comments")).toEqual(
        Object.keys(was).filter((k) => k !== "comments"),
      );
      // Byte for byte but for the two lines the change is about.
      const lines = (text: string) =>
        text.split("\n").filter((l) => !l.startsWith("updated_at:") && l !== "");
      const added = lines(after).filter((l) => !lines(before).includes(l));
      for (const line of added) expect(line).toMatch(/^(comments:| {2}- at: | {4}text: read back)/);
      expect(lines(before).filter((l) => !lines(after).includes(l))).toEqual([]);
    }
    expect(Object.keys(await onDisk("TASK-KKKK"))).toEqual([
      "v",
      "id",
      "key",
      "title",
      "body",
      "priority",
      "status",
      "comments",
      "depends_on",
      "conflicts_with",
      "created_at",
      "updated_at",
    ]);
  });

  test("t45_older_writer_keeps_the_link_keys", async () => {
    // The record schema and the field order of the published beta, copied here: a real older build
    // cannot be run in a test. It passes unknown keys through and writes them after the known ones.
    const betaSchema = z
      .object({
        v: z.number().int().min(1),
        id: z.string().min(1),
        key: z.string().min(1),
        title: z.string().min(1),
        body: z.string().optional(),
        priority: z.enum(["high", "normal", "low"]),
        status: z.enum(["todo", "progress", "done", "declined"]),
        comments: z
          .array(z.object({ at: z.string(), text: z.string(), by: z.string().optional() }))
          .optional(),
        parent: z.string().optional(),
        runs: z.array(z.string()).optional(),
        created_at: z.string(),
        updated_at: z.string(),
      })
      .passthrough();
    const betaOrder = [
      "v",
      "id",
      "key",
      "title",
      "body",
      "priority",
      "status",
      "comments",
      "parent",
      "runs",
      "created_at",
      "updated_at",
    ];
    const text = await readFile(join(FIXTURES, "with-links.yaml"), "utf8");
    const record = betaSchema.parse(parse(text)) as Record<string, unknown>;
    record.updated_at = "2026-11-23T08:00:00.000Z";
    const ordered: Record<string, unknown> = {};
    for (const name of betaOrder) if (record[name] !== undefined) ordered[name] = record[name];
    for (const [name, value] of Object.entries(record)) {
      if (!(name in ordered) && value !== undefined) ordered[name] = value;
    }
    await writeFile(fileOf("TASK-KKKK"), stringify(ordered));

    // Kept, at the end of the file; this build reads them from there.
    expect(Object.keys(await onDisk("TASK-KKKK")).slice(-2)).toEqual([
      "depends_on",
      "conflicts_with",
    ]);
    const a = adapter("TASK");
    const read = await get(a, "TASK-KKKK");
    expect(read.depends_on).toEqual(["TASK-DDDD"]);
    expect(read.conflicts_with).toEqual(["TASK-CCCC"]);
    expect((await a.list(ALL, o())).problems).toEqual([]);
  });
});

describe("t45 files a person or a merge left", () => {
  test("t45_bad_links_block_one_task_not_the_project", async () => {
    await put("KDL-2222", { depends_on: ["KDL-ZZZZ"] });
    await put("KDL-3333", { depends_on: ["not a key at all"] });
    await put("KDL-4444", { depends_on: ["KDL-5555"] });
    await put("KDL-5555", { depends_on: ["KDL-4444"] });
    await put("KDL-6666", { depends_on: ["KDL-6666"] });
    await put("KDL-7777", { conflicts_with: ["KDL-YYYY"] });
    await put("KDL-8888");
    const keys = ["2222", "3333", "4444", "5555", "6666", "7777", "8888"].map((s) => `KDL-${s}`);
    const before = await Promise.all(keys.map(textOf));

    const a = adapter();
    const listed = await a.list(ALL, o());
    // The list is complete: these are not problems of the list, so the daemon still starts the rest.
    expect(listed.problems).toEqual([]);
    expect(listed.truncated).toBe(false);
    const rows = Object.fromEntries(listed.tasks.map((t) => [t.key, t]));
    expect(Object.keys(rows).sort()).toEqual(keys);
    expect(rows["KDL-2222"]?.blocked_by).toEqual(["KDL-ZZZZ"]);
    expect(rows["KDL-2222"]?.dependencies).toEqual([{ key: "KDL-ZZZZ", state: "missing" }]);
    expect(rows["KDL-3333"]?.blocked_by).toEqual(["not a key at all"]);
    expect(rows["KDL-4444"]?.blocked_by).toEqual(["KDL-5555"]);
    expect(rows["KDL-5555"]?.blocked_by).toEqual(["KDL-4444"]);
    expect(rows["KDL-6666"]?.blocked_by).toEqual(["KDL-6666"]);
    expect(rows["KDL-7777"]?.blocked_by).toBeUndefined();
    expect(rows["KDL-7777"]?.conflicts_with).toEqual(["KDL-YYYY"]);
    expect(rows["KDL-8888"]?.blocked_by).toBeUndefined();

    await a.verify(o());
    for (const key of keys) await a.get(key, o());
    expect(await Promise.all(keys.map(textOf))).toEqual(before);

    // The tools can take such a link away, though its key names no task.
    const fixed = await a.update("KDL-2222", { remove_depends_on: ["KDL-ZZZZ"] }, o());
    expect(fixed?.task.blocked_by).toBeUndefined();
    expect("depends_on" in (await onDisk("KDL-2222"))).toBe(false);
  });

  test("t45_malformed_link_values_are_a_file_problem", async () => {
    const bad: [string, unknown][] = [
      ["KDL-2222", Array.from({ length: 21 }, (_, i) => `KDL-${2000 + i}`)],
      ["KDL-3333", ["KDL-8888", 7]],
      ["KDL-4444", null],
      ["KDL-5555", "KDL-8888"],
      ["KDL-6666", ["K".repeat(65)]],
      ["KDL-7777", [""]],
    ];
    for (const [key, value] of bad) await put(key, { depends_on: value });
    await put("KDL-9999", { conflicts_with: { key: "KDL-8888" } });
    await put("KDL-8888");
    const keys = [...bad.map(([key]) => key), "KDL-9999"];
    const before = await Promise.all(keys.map(textOf));

    const a = adapter();
    const listed = await a.list(ALL, o());
    expect(listed.tasks.map((t) => t.key)).toEqual(["KDL-8888"]);
    expect(listed.problems.map((p) => p.key).sort()).toEqual([...keys].sort());
    for (const problem of listed.problems) {
      expect(problem.message).toMatch(/is not a valid task \((depends_on|conflicts_with)/);
    }
    // Such a file is never rewritten, and nothing links to it.
    for (const key of keys) {
      expect((await refused(a.update(key, { comment: "x" }, o()))).code).toBe(
        "TASK_ADAPTER_FAILED",
      );
    }
    expect((await refused(a.update("KDL-8888", { add_depends_on: ["KDL-2222"] }, o()))).code).toBe(
      "TASK_NOT_FOUND",
    );
    expect(await Promise.all(keys.map(textOf))).toEqual(before);
    // A task that depends on a file that cannot be read waits (fail closed).
    await put("KDL-AAAA", { depends_on: ["KDL-4444"] });
    expect((await get(a, "KDL-AAAA")).dependencies).toEqual([
      { key: "KDL-4444", state: "missing" },
    ]);
  });

  test("t45_doctor_names_bad_links", async () => {
    await put("KDL-2222", { depends_on: ["KDL-ZZZZ"] });
    await put("KDL-3333", { conflicts_with: ["KDL-YYYY"] });
    await put("KDL-4444", { depends_on: ["KDL-5555"] });
    await put("KDL-5555", { depends_on: ["KDL-6666"] });
    await put("KDL-6666", { depends_on: ["KDL-4444"] });
    await put("KDL-7777", { depends_on: ["KDL-4444"] });
    const a = adapter();
    const problems = await a.verify(o());
    const messages = problems.map((p) => p.message);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain('KDL-2222 depends on "KDL-ZZZZ", which is not here');
    expect(messages[1]).toContain('KDL-3333 names a conflict with "KDL-YYYY", which is not here');
    expect(messages[2]).toContain(
      "a cycle of depends_on: KDL-4444 -> KDL-5555 -> KDL-6666 -> KDL-4444",
    );
    // The service's doctor carries them, and a healthy folder has none.
    const answer = await new TaskService(a).verify();
    expect((answer as unknown as { problems: unknown[] }).problems).toHaveLength(3);
    await a.update("KDL-2222", { clear: ["depends_on"] }, o());
    await a.update("KDL-3333", { clear: ["conflicts_with"] }, o());
    await a.update("KDL-6666", { clear: ["depends_on"] }, o());
    expect(await a.verify(o())).toEqual([]);
  });

  test("t45_cycle_from_two_writers_is_caught_on_read", async () => {
    // Two writers each added half (the check and the write are one step per task, not per folder);
    // on disk it is the same as a cycle from a merge.
    await put("KDL-2222", { depends_on: ["KDL-3333"] });
    await put("KDL-3333", { depends_on: ["KDL-2222"] });
    const a = adapter();
    expect((await get(a, "KDL-2222")).blocked_by).toEqual(["KDL-3333"]);
    expect((await get(a, "KDL-3333")).blocked_by).toEqual(["KDL-2222"]);
    expect((await a.list(ALL, o())).problems).toEqual([]);
    const problems = await a.verify(o());
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringContaining("a cycle of depends_on: KDL-2222 -> KDL-3333 -> KDL-2222"),
    ]);
    // The tools refuse to make one, and say which.
    await put("KDL-4444");
    await put("KDL-5555", { depends_on: ["KDL-4444"] });
    const refusal = await refused(a.update("KDL-4444", { add_depends_on: ["KDL-5555"] }, o()));
    expect(refusal.code).toBe("INVALID_TASK");
    expect(refusal.message).toContain("KDL-4444 -> KDL-5555 -> KDL-4444");
    expect("depends_on" in (await onDisk("KDL-4444"))).toBe(false);
  });
});
