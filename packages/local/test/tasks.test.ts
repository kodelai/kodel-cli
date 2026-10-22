import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KodelError, type TaskFilter } from "@kodel-ai/pipeline-core";
import { CONFIG_FILE, LocalTaskAdapter, openTaskService, TASKS_DIR } from "../src";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kodel-localtasks-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const signal = () => ({ signal: new AbortController().signal });
const ALL: TaskFilter["state"] = ["todo", "progress", "done"];
const RUN = (n: number) => `r_${n.toString(36).padStart(9, "0")}_abcd`;

function adapter(options: { prefix?: string; random?: () => number } = {}) {
  let now = Date.UTC(2026, 9, 22);
  return new LocalTaskAdapter({
    storeRoot: root,
    prefix: options.prefix ?? "KDL",
    clock: () => {
      now += 1000;
      return now;
    },
    random: options.random ?? Math.random,
  });
}

/** Returns a fixed value for the first `times` calls, then another. */
const stuck = (first: number, times: number, then = 0.99) => {
  let calls = 0;
  return () => (calls++ < times ? first : then);
};

const tasksDir = () => join(root, TASKS_DIR);
const fileOf = (key: string) => join(tasksDir(), `${key}.yaml`);
const refused = async (work: Promise<unknown>): Promise<KodelError> => {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(KodelError);
    return error as KodelError;
  }
  throw new Error("did not fail");
};

describe("keys and ids", () => {
  test("t3_a_key_is_PREFIX_and_four_characters_without_the_confusing_ones", async () => {
    const a = adapter();
    for (let i = 0; i < 40; i += 1) {
      const task = await a.create({ title: `t${i}` });
      expect(task.key).toMatch(/^KDL-[2-9A-HJKMNP-TV-Z]{4}$/);
      expect(task.key.slice(-4)).not.toMatch(/[01ILOU]/);
    }
  });

  test("t11_the_id_is_the_suffix_and_the_file_says_so", async () => {
    const a = adapter({ random: () => 0 });
    const task = await a.create({ title: "t" });
    expect(task.key).toBe("KDL-2222");
    expect(task.id).toBe("2222");
    const text = await readFile(fileOf("KDL-2222"), "utf8");
    expect(text).toContain('id: "2222"');
    expect(text).toContain("key: KDL-2222");
    expect(text).toMatch(/^v: 1$/m);
  });

  test("the file reads in a fixed order and holds the whole task", async () => {
    const a = adapter();
    const parent = await a.create({ title: "parent" });
    const child = await a.create({
      title: "child",
      body: "text",
      comment: "first",
      run: RUN(1),
      parent: parent.key,
    });
    const lines = (await readFile(fileOf(child.key), "utf8")).split("\n");
    const order = [
      "v:",
      "id:",
      "key:",
      "title:",
      "body:",
      "priority:",
      "status:",
      "comments:",
      "parent:",
      "runs:",
      "created_at:",
      "updated_at:",
    ];
    const at = order.map((name) => lines.findIndex((l) => l.startsWith(name)));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
  });

  test("50 tasks created at once all get a key of their own", async () => {
    const a = adapter();
    const made = await Promise.all(
      Array.from({ length: 50 }, (_, i) => a.create({ title: `t${i}` })),
    );
    expect(new Set(made.map((t) => t.key)).size).toBe(50);
    expect((await readdir(tasksDir())).length).toBe(50);
  });

  test("t3_two_adapters_that_pick_the_same_suffix_do_not_overwrite_each_other", async () => {
    // Both see an empty folder and both draw 2222: `wx` lets one win, the other draws again.
    const a = adapter({ random: stuck(0, 4) });
    const b = adapter({ random: stuck(0, 4, 0.5) });
    const [x, y] = await Promise.all([a.create({ title: "x" }), b.create({ title: "y" })]);
    expect(x.key).not.toBe(y.key);
    const names = await readdir(tasksDir());
    expect(names.length).toBe(2);
    const titles = await Promise.all(
      [x, y].map(async (t) => (await a.get(t.key, signal()))?.task.title),
    );
    expect(titles.sort()).toEqual(["x", "y"]);
  });

  test("a random source stuck on one value gives TASK_KEY_UNAVAILABLE, not an overwrite", async () => {
    const a = adapter({ random: () => 0 });
    await a.create({ title: "first" });
    const error = await refused(a.create({ title: "second" }));
    expect(error.code).toBe("TASK_KEY_UNAVAILABLE");
    expect((await a.get("KDL-2222", signal()))?.task.title).toBe("first");
  });

  test("t11_the_id_is_unique_whatever_the_prefix", async () => {
    await adapter({ prefix: "OLD", random: () => 0 }).create({ title: "old" });
    // The new adapter first draws 2222, which a file with another prefix already uses.
    const fresh = await adapter({ prefix: "NEW", random: stuck(0, 4) }).create({ title: "new" });
    expect(fresh.id).not.toBe("2222");
    expect(fresh.key.startsWith("NEW-")).toBe(true);
  });

  test("a changed prefix keeps the old tasks readable and names only the new ones differently", async () => {
    const old = await adapter({ prefix: "OLD" }).create({ title: "old" });
    const next = adapter({ prefix: "NEW" });
    const fresh = await next.create({ title: "new" });
    expect(fresh.key.startsWith("NEW-")).toBe(true);
    const listed = await next.list({ state: ALL, limit: 50 }, signal());
    expect(listed.tasks.map((t) => t.key).sort()).toEqual([old.key, fresh.key].sort());
    expect((await next.get(old.key, signal()))?.task.title).toBe("old");
  });

  test("resolveKey: case, bare suffix, unknown suffix and rubbish", async () => {
    const a = adapter();
    const task = await a.create({ title: "t" });
    const suffix = task.key.slice(-4);
    expect(await a.resolveKey(task.key.toLowerCase(), signal())).toBe(task.key);
    expect(await a.resolveKey(` ${task.key} `, signal())).toBe(task.key);
    expect(await a.resolveKey(suffix.toLowerCase(), signal())).toBe(task.key);
    expect(await a.resolveKey("ZZZZ", signal())).toBeUndefined();
    for (const bad of ["KDL-1234", "KDL-ABC", "kdl", "../KDL-2222", "KDL-2222.yaml", "K-2222"]) {
      expect(await a.resolveKey(bad, signal())).toBeUndefined();
    }
  });

  test("get and update accept the id as well as the key", async () => {
    const a = adapter();
    const task = await a.create({ title: "t" });
    expect((await a.get(task.id as string, signal()))?.task.key).toBe(task.key);
    expect((await a.update(task.id as string, { title: "u" }, signal()))?.task.title).toBe("u");
  });

  test("the times come from the injected clock", async () => {
    const a = adapter();
    const task = await a.create({ title: "t" });
    expect(task.created_at).toBe("2026-10-22T00:00:01.000Z");
    const updated = await a.update(task.key, { title: "u" }, signal());
    expect(updated?.task.updated_at).toBe("2026-10-22T00:00:02.000Z");
    expect(updated?.task.created_at).toBe(task.created_at);
  });
});

describe("what is wrong with a file is reported and hides nothing", () => {
  test("a broken file, a key that does not match the name and an id that does not match", async () => {
    const a = adapter();
    const good = await a.create({ title: "good" });
    await writeFile(fileOf("KDL-3333"), "title: [unclosed\n");
    await writeFile(
      fileOf("KDL-4444"),
      'v: 1\nid: "4444"\nkey: KDL-5555\ntitle: x\npriority: normal\nstatus: todo\ncreated_at: a\nupdated_at: a\n',
    );
    await writeFile(
      fileOf("KDL-6666"),
      'v: 1\nid: "7777"\nkey: KDL-6666\ntitle: x\npriority: normal\nstatus: todo\ncreated_at: a\nupdated_at: a\n',
    );
    await writeFile(fileOf("KDL-8888"), "v: 1\nkey: KDL-8888\n");
    const listed = await a.list({ state: ALL, limit: 50 }, signal());
    expect(listed.tasks.map((t) => t.key)).toEqual([good.key]);
    expect(listed.problems.map((p) => p.key).sort()).toEqual([
      "KDL-3333",
      "KDL-4444",
      "KDL-6666",
      "KDL-8888",
    ]);
    const messages = listed.problems.map((p) => p.message).join("\n");
    expect(messages).toContain("not valid YAML");
    expect(messages).toContain("KDL-4444.yaml holds another key");
    expect(messages).toContain("KDL-6666.yaml holds another id");
    // What the file says is never quoted back.
    expect(messages).not.toContain("KDL-5555");
    expect(messages).not.toContain("7777");
  });

  test("t19_a_task_written_in_a_newer_format_is_reported_and_never_rewritten", async () => {
    const a = adapter();
    const good = await a.create({ title: "good" });
    const newer = 'v: 2\nid: "3333"\nkey: KDL-3333\ntitle: from the future\nfuture_field: 1\n';
    await writeFile(fileOf("KDL-3333"), newer);
    const listed = await a.list({ state: ALL, limit: 50 }, signal());
    expect(listed.tasks.map((t) => t.key)).toEqual([good.key]);
    expect(listed.problems).toEqual([
      {
        key: "KDL-3333",
        message: expect.stringContaining("written in task format 2; upgrade kodel"),
      },
    ]);
    const error = await refused(a.update("KDL-3333", { title: "changed" }, signal()));
    expect(error.code).toBe("TASK_ADAPTER_FAILED");
    expect(error.message).toContain("upgrade kodel");
    expect(await readFile(fileOf("KDL-3333"), "utf8")).toBe(newer);
  });

  test("keys a later minor of the format adds survive a rewrite", async () => {
    const a = adapter();
    const task = await a.create({ title: "t" });
    const text = `${await readFile(fileOf(task.key), "utf8")}labels:\n  - a\n`;
    await writeFile(fileOf(task.key), text);
    await a.update(task.key, { title: "u" }, signal());
    const after = await readFile(fileOf(task.key), "utf8");
    expect(after).toContain("labels:");
    expect(after).toContain("title: u");
  });

  test("a leftover temp file and a stray file are not tasks", async () => {
    const a = adapter();
    await a.create({ title: "t" });
    await writeFile(join(tasksDir(), "KDL-2222.yaml.123.tmp"), "junk");
    await writeFile(join(tasksDir(), "README.md"), "notes");
    const listed = await a.list({ state: ALL, limit: 50 }, signal());
    expect(listed.tasks.length).toBe(1);
    expect(listed.problems).toEqual([]);
  });

  test("an update leaves no temp file behind", async () => {
    const a = adapter();
    const task = await a.create({ title: "t" });
    await a.update(task.key, { title: "u", comment: "c" }, signal());
    expect((await readdir(tasksDir())).every((n) => n.endsWith(".yaml"))).toBe(true);
  });

  test("verify reports the problems of the folder", async () => {
    const a = adapter();
    await mkdir(tasksDir(), { recursive: true });
    await writeFile(fileOf("KDL-3333"), "nonsense: [");
    expect((await a.verify(signal())).length).toBe(1);
  });
});

describe("t8_subtasks_of_any_depth", () => {
  test("a chain ten levels deep works and each level counts its direct children only", async () => {
    const a = adapter();
    let parent = await a.create({ title: "level 0" });
    const keys = [parent.key];
    for (let level = 1; level <= 10; level += 1) {
      parent = await a.create({ title: `level ${level}`, parent: parent.key });
      keys.push(parent.key);
    }
    const listed = await a.list({ state: ALL, limit: 50 }, signal());
    expect(listed.tasks.length).toBe(11);
    expect(listed.tasks.filter((t) => t.subtasks?.total === 1).length).toBe(10);
    expect((await a.get(keys[10] as string, signal()))?.task.parent).toBe(keys[9]);
    const top = await a.list({ state: ALL, limit: 50, top_level: true }, signal());
    expect(top.tasks.map((t) => t.key)).toEqual([keys[0] as string]);
  });

  test("a move that would close a cycle, and a task under itself, are refused", async () => {
    const a = adapter();
    const x = await a.create({ title: "x" });
    const y = await a.create({ title: "y", parent: x.key });
    const z = await a.create({ title: "z", parent: y.key });
    for (const [key, parent] of [
      [x.key, z.key],
      [x.key, x.key],
      [x.key, y.key],
    ] as const) {
      const error = await refused(a.update(key, { parent }, signal()));
      expect(error.code).toBe("INVALID_TASK");
      expect(error.message).toContain("cycle");
    }
    expect((await a.get(x.key, signal()))?.task.parent).toBeUndefined();
  });

  test("a subtask whose parent is gone is shown on its own and reported", async () => {
    const a = adapter();
    const parent = await a.create({ title: "parent" });
    const child = await a.create({ title: "child", parent: parent.key });
    await rm(fileOf(parent.key));
    const listed = await a.list({ state: ALL, limit: 50 }, signal());
    expect(listed.tasks.map((t) => t.key)).toEqual([child.key]);
    expect(listed.tasks[0]?.parent).toBeUndefined();
    expect(listed.problems.map((p) => p.message).join()).toContain("not here");
    const top = await a.list({ state: ALL, limit: 50, top_level: true }, signal());
    expect(top.tasks.length).toBe(1);
  });

  test("a cycle that two merged branches made is reported and breaks nothing", async () => {
    const a = adapter();
    const one = await a.create({ title: "one" });
    const two = await a.create({ title: "two", parent: one.key });
    // One branch made two a child of one; the other made one a child of two. Both are valid
    // files alone; together they are a cycle.
    const text = await readFile(fileOf(one.key), "utf8");
    await writeFile(fileOf(one.key), `${text}parent: ${two.key}\n`);
    const listed = await a.list({ state: ALL, limit: 50 }, signal());
    expect(listed.tasks.length).toBe(2);
    expect(listed.tasks.every((t) => t.parent === undefined)).toBe(true);
    expect(listed.problems.length).toBe(2);
    expect(listed.problems.every((p) => p.message.includes("cycle"))).toBe(true);
    expect((await a.get(one.key, signal()))?.subtasks).toEqual([]);
  });

  test("a parent that does not exist is TASK_NOT_FOUND", async () => {
    const a = adapter();
    const error = await refused(a.create({ title: "t", parent: "KDL-2222" }, signal()));
    expect(error.code).toBe("TASK_NOT_FOUND");
  });

  test("t8_status_does_not_travel_between_parent_and_child", async () => {
    const a = adapter();
    const parent = await a.create({ title: "p" });
    const child = await a.create({ title: "c", parent: parent.key });
    const done = await a.update(parent.key, { status: "done" }, signal());
    expect(done?.open_subtasks).toBe(1);
    expect((await a.get(child.key, signal()))?.task.status).toBe("todo");
    await a.update(child.key, { status: "declined" }, signal());
    const listed = await a.list({ state: ALL, limit: 50 }, signal());
    expect(listed.tasks.find((t) => t.key === parent.key)?.subtasks).toEqual({ total: 1, done: 1 });
    expect(listed.tasks.find((t) => t.key === parent.key)?.status).toBe("done");
  });
});

describe("comments, runs and clearing", () => {
  test("t10_comments_only_grow_and_the_last_is_the_comment", async () => {
    const a = adapter();
    const task = await a.create({ title: "t", comment: "one" });
    await a.update(task.key, { comment: "two" }, signal());
    const got = (await a.get(task.key, signal()))?.task;
    expect(got?.comments?.map((c) => c.text)).toEqual(["one", "two"]);
    expect(got?.comment).toBe("two");
    const text = await readFile(fileOf(task.key), "utf8");
    expect(text).toContain("comments:");
    expect(text).not.toMatch(/^comment:/m);
  });

  test("a summary shows the latest comment so a reason for a decline is seen in the list", async () => {
    const a = adapter();
    const task = await a.create({ title: "t" });
    await a.update(task.key, { status: "declined", comment: "by design" }, signal());
    const listed = await a.list({ state: ["done"], limit: 5 }, signal());
    expect(listed.tasks[0]).toMatchObject({
      status: "declined",
      state: "done",
      comment: "by design",
    });
  });

  test("t9_runs_are_bounded_at_a_hundred_and_a_repeat_is_ignored", async () => {
    const a = adapter();
    const task = await a.create({ title: "t", run: RUN(0) });
    for (let i = 1; i < 100; i += 1) await a.update(task.key, { add_run: RUN(i) }, signal());
    expect((await a.get(task.key, signal()))?.task.runs.length).toBe(100);
    await a.update(task.key, { add_run: RUN(5) }, signal());
    expect((await a.get(task.key, signal()))?.task.runs.length).toBe(100);
    const error = await refused(a.update(task.key, { add_run: RUN(999) }, signal()));
    expect(error.code).toBe("INVALID_TASK");
  });

  test("t17_clear_resets_the_priority_to_its_default_and_removes_body_and_parent", async () => {
    const a = adapter();
    const parent = await a.create({ title: "p" });
    const task = await a.create({ title: "t", body: "b", priority: "high", parent: parent.key });
    const cleared = await a.update(task.key, { clear: ["body", "priority", "parent"] }, signal());
    expect(cleared?.task.body).toBeUndefined();
    expect(cleared?.task.priority).toBe("normal");
    expect(cleared?.task.parent).toBeUndefined();
    expect(await readFile(fileOf(task.key), "utf8")).not.toContain("body:");
  });

  test("types and fields are not there and say so", async () => {
    const a = adapter();
    const task = await a.create({ title: "t" });
    expect((await refused(a.create({ title: "t", type: "Bug" }, signal()))).code).toBe(
      "TASK_UNSUPPORTED",
    );
    expect((await refused(a.update(task.key, { fields: { A: "b" } }, signal()))).code).toBe(
      "TASK_UNSUPPORTED",
    );
    expect((await refused(a.update(task.key, { clear: ["fields.A"] }, signal()))).code).toBe(
      "TASK_UNSUPPORTED",
    );
  });
});

describe("the list", () => {
  test("the order is priority, then the oldest, then the key", async () => {
    const a = adapter();
    const low = await a.create({ title: "low", priority: "low" });
    const normal1 = await a.create({ title: "n1" });
    const high = await a.create({ title: "high", priority: "high" });
    const normal2 = await a.create({ title: "n2" });
    const listed = await a.list({ state: ALL, limit: 50 }, signal());
    expect(listed.tasks.map((t) => t.key)).toEqual([high.key, normal1.key, normal2.key, low.key]);
  });

  test("t18_a_task_added_between_two_pages_neither_repeats_nor_hides_one", async () => {
    const a = adapter();
    const first = [];
    for (let i = 0; i < 4; i += 1) first.push((await a.create({ title: `t${i}` })).key);
    const page1 = await a.list({ state: ALL, limit: 2 }, signal());
    expect(page1.tasks.map((t) => t.key)).toEqual(first.slice(0, 2));
    const late = (await a.create({ title: "late" })).key;
    const early = (await a.create({ title: "urgent", priority: "high" })).key;
    const seen = [...page1.tasks.map((t) => t.key)];
    let cursor = page1.next;
    while (cursor) {
      const page = await a.list({ state: ALL, limit: 2, cursor }, signal());
      seen.push(...page.tasks.map((t) => t.key));
      cursor = page.next;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...first, late]);
    // The urgent one sorts before the cursor, so this walk does not see it; a fresh list does.
    expect(seen).not.toContain(early);
    expect((await a.list({ state: ALL, limit: 50 }, signal())).tasks[0]?.key).toBe(early);
  });

  test("a cursor that is not ours is INVALID_TASK", async () => {
    const a = adapter();
    expect(
      (await refused(a.list({ state: ALL, limit: 5, cursor: "garbage" }, signal()))).code,
    ).toBe("INVALID_TASK");
  });

  test("an empty or missing folder is an empty list", async () => {
    const a = adapter();
    expect(await a.list({ state: ALL, limit: 5 }, signal())).toEqual({
      tasks: [],
      truncated: false,
      problems: [],
    });
  });

  test("the schema tells the agent the four statuses and three priorities", async () => {
    const a = adapter();
    const schema = await a.schema({}, signal());
    expect(schema.statuses.map((s) => `${s.name}:${s.state}`)).toEqual([
      "todo:todo",
      "progress:progress",
      "done:done",
      "declined:done",
    ]);
    expect(schema.priorities?.map((p) => p.name)).toEqual(["high", "normal", "low"]);
    expect(schema.fields).toEqual([]);
    expect(a.capabilities).toEqual({
      subtasks: true,
      runs: "full",
      comment: "append",
      fields: false,
      priority: true,
      types: false,
    });
  });

  test("the schema for a task lists the moves, any to any", async () => {
    const a = adapter();
    const task = await a.create({ title: "t" });
    const schema = await a.schema({ key: task.key }, signal());
    expect(schema.transitions?.map((t) => t.to)).toEqual(["progress", "done", "declined"]);
    expect((await refused(a.schema({ key: "KDL-2222" }, signal()))).code).toBe("TASK_NOT_FOUND");
  });
});

describe("opening the service from the config", () => {
  const write = (text: string) => writeFile(join(root, CONFIG_FILE), text);

  test("t3_tasks_are_off_unless_the_config_turns_them_on", async () => {
    expect(await openTaskService({ storeRoot: root })).toBeUndefined();
    await write("tasks:\n  enabled: false\n");
    expect(await openTaskService({ storeRoot: root })).toBeUndefined();
  });

  test("an enabled config gives a working service with the prefix of its own block", async () => {
    await write("tasks:\n  enabled: true\n  adapters:\n    local:\n      prefix: ABC\n");
    const opened = await openTaskService({ storeRoot: root });
    expect(opened?.config.adapter).toBe("local");
    const made = await opened?.service.create({ title: "t" });
    expect(made).toMatchObject({ ok: true, task: { key: expect.stringMatching(/^ABC-/) } });
  });

  test("local is the adapter when none is named, and its prefix defaults to TASK", async () => {
    await write("tasks:\n  enabled: true\n");
    const made = await (await openTaskService({ storeRoot: root }))?.service.create({ title: "t" });
    expect(made).toMatchObject({ ok: true, task: { key: expect.stringMatching(/^TASK-/) } });
  });

  test("t4_the_blocks_of_other_adapters_are_ignored_whatever_is_in_them", async () => {
    await write(
      "tasks:\n  enabled: true\n  adapters:\n    jira:\n      nonsense: [1, 2]\n    linear: null\n",
    );
    expect(await openTaskService({ storeRoot: root })).toBeDefined();
  });

  test("an unknown adapter is CONFIG_INVALID and names the known ones", async () => {
    await write("tasks:\n  enabled: true\n  adapter: trello\n");
    const error = await refused(openTaskService({ storeRoot: root }));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("trello");
    expect(error.message).toContain("local");
  });

  test("a bad block of the adapter in use is refused with its path in the message", async () => {
    await write("tasks:\n  enabled: true\n  adapters:\n    local:\n      prefix: kdl\n");
    const error = await refused(openTaskService({ storeRoot: root }));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("tasks.adapters.local");
    expect(error.message).toContain("prefix");
    await write("tasks:\n  enabled: true\n  adapters:\n    local:\n      prefx: KDL\n");
    expect((await refused(openTaskService({ storeRoot: root }))).message).toContain("prefx");
  });
});
