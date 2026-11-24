/**
 * Tasks in the web UI (T-44): read as the terminal reads them; what a task says is redacted before it
 * leaves the machine; a comment and a new task are cleaned the way the terminal's form cleans them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardSlot, NewTaskInput } from "../src/tui/tasks-load";
import { demoApi } from "../src/web/command";
import { DeviceStore } from "../src/web/devices";
import { createHandler, type WebApi, type WebResponse } from "../src/web/handler";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-web-tasks-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const HOST = "127.0.0.1:4317";

async function paired(api: WebApi) {
  const devices = new DeviceStore(join(dir, "web"));
  const web = createHandler({
    api,
    devices,
    assets: { html: "", js: "", css: "" },
    secureCookie: false,
    audit: () => undefined,
  });
  const { code } = await devices.createPairing();
  const answer = await web.handle({
    method: "POST",
    path: "/api/pair",
    query: new URLSearchParams(),
    headers: { host: HOST, origin: `http://${HOST}`, "content-type": "application/json" },
    body: JSON.stringify({ code, name: "phone" }),
    ip: "127.0.0.1",
  });
  const cookie = (answer.headers["set-cookie"] ?? "").split(";")[0] ?? "";
  const call = (method: string, path: string, body?: unknown): Promise<WebResponse> =>
    web.handle({
      method,
      path,
      query: new URLSearchParams(),
      headers: {
        host: HOST,
        origin: `http://${HOST}`,
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? "" : JSON.stringify(body),
      ip: "127.0.0.1",
    });
  return call;
}

const json = (r: WebResponse) => JSON.parse(String(r.body));

describe("tasks", () => {
  test("t44_tasks_read_as_the_terminal_reads_them", async () => {
    const call = await paired(await demoApi(Date.now()));
    const list = json(await call("GET", "/api/tasks"));
    expect(list.tasks.status).toBe("ready");
    const key = list.tasks.rows[0].key as string;
    const card = json(await call("GET", `/api/tasks/${key}`));
    expect(card.task).toMatchObject({ status: "ready", card: { key } });
    expect((await call("GET", "/api/tasks/..%2Fetc")).status).toBe(400);
  });

  test("t44_what_a_task_says_is_redacted", async () => {
    const secret = `AKIA${"C".repeat(16)}`;
    const card: CardSlot = {
      status: "ready",
      card: {
        key: "T-1",
        title: `title ${secret}`,
        state: "todo",
        status: "todo",
        runs: [],
        body: `body ${secret}`,
        comments: [{ text: `note ${secret}`, at: "2026-11-22T10:00:00Z" }],
        subtasks: [{ key: "T-2", title: `kid ${secret}` }],
      },
    };
    const api: WebApi = {
      ...(await demoApi(Date.now())),
      task: async () => card,
    };
    const call = await paired(api);
    const answer = await call("GET", "/api/tasks/T-1");
    expect(String(answer.body)).not.toContain(secret);
  });

  test("t44_task_comment_and_new_task_are_cleaned", async () => {
    const comments: string[] = [];
    const made: NewTaskInput[] = [];
    const api: WebApi = {
      ...(await demoApi(Date.now())),
      addTaskComment: async (_key, text) => {
        comments.push(text);
      },
      createTask: async (input) => {
        made.push(input);
        return { key: "T-9" };
      },
    };
    const call = await paired(api);
    expect((await call("POST", "/api/tasks/T-1/comments", { text: "a\u0007b\nc" })).status).toBe(
      200,
    );
    expect(comments).toEqual(["ab\nc"]);
    expect((await call("POST", "/api/tasks/T-1/comments", { text: "  \u0001 " })).status).toBe(400);
    const created = json(
      await call("POST", "/api/tasks", { title: "Fix\nit", body: "  ", priority: "high" }),
    );
    expect(created.key).toBe("T-9");
    expect(made).toEqual([{ title: "Fix it", priority: "high" }]);
    expect((await call("POST", "/api/tasks", { title: "x", priority: "urgent" })).status).toBe(400);
  });

  test("t44_a_server_without_tasks_says_so", async () => {
    const api: WebApi = { ...(await demoApi(Date.now())) };
    delete api.tasks;
    delete api.task;
    const call = await paired(api);
    expect(json(await call("GET", "/api/me")).canTasks).toBe(false);
    expect((await call("GET", "/api/tasks")).status).toBe(404);
  });
});
