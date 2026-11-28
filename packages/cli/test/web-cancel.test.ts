/**
 * Cancelling a run from the web UI (TASK-NE3N): the reason is checked first, and only the second
 * request, with the flow the check handed to that very device for that very run, cancels.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "@kodel-ai/pipeline-core";
import type { CancelPorts } from "../src/cancel-run";
import type { Session } from "../src/tui/session";
import { projectApi } from "../src/web/command";
import { DeviceStore } from "../src/web/devices";
import {
  COOKIE,
  createHandler,
  type WebApi,
  type WebCancelOutcome,
  type WebRequest,
  type WebResponse,
} from "../src/web/handler";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-web-cancel-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const HOST = "127.0.0.1:4317";

function request(method: string, path: string, cookie: string, body?: unknown): WebRequest {
  const url = new URL(path, `http://${HOST}`);
  return {
    method,
    path: url.pathname,
    query: url.searchParams,
    headers: {
      host: HOST,
      cookie: `${COOKIE}=${cookie}`,
      origin: `http://${HOST}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ip: "10.0.0.1",
  };
}

const bodyOf = (r: WebResponse) => JSON.parse(String(r.body)) as Record<string, unknown>;

const session = (id: string, status: Session["status"], taskKey?: string): Session => ({
  id,
  title: id,
  pipeline: "dev",
  status,
  step: "build",
  since: 0,
  steps: [],
  log: [],
  ...(taskKey === undefined ? {} : { taskKey }),
});

const answerOf = (runId: string): WebCancelOutcome => ({
  ok: true,
  run_id: runId,
  status: "canceled",
  noop: false,
  task: { key: "TASK-1", still_open: true },
  branch: `kodel/${runId}`,
  worktree: `/w/${runId}`,
  remove_commands: [`git worktree remove /w/${runId}`, `git branch -d kodel/${runId}`],
  agents_left: [],
  notes: [],
});

function fakeApi(cancelable = true) {
  const canceled: { runId: string; reason: string }[] = [];
  const api: WebApi = {
    source: "project",
    project: "p",
    sessions: async () => ({
      sessions: [
        session("r_run", "running", "TASK-1"),
        session("r_gate", "waiting"),
        session("r_done", "done"),
        session("r_gone", "canceled"),
      ],
      proposals: 0,
    }),
    detail: async () => undefined,
    diff: async () => ({ kind: "missing" }),
    ...(cancelable
      ? {
          cancel: async (runId: string, reason: string) => {
            canceled.push({ runId, reason });
            return answerOf(runId);
          },
        }
      : {}),
  };
  return { api, canceled };
}

async function setup(api: WebApi) {
  const devices = new DeviceStore(join(dir, "web"));
  const audit: string[] = [];
  const handler = createHandler({
    api,
    devices,
    assets: { html: "", js: "", css: "" },
    secureCookie: false,
    audit: (line) => audit.push(line),
    redact: (text) => text.replace(/sk-[A-Za-z0-9]{10,}/g, "[REDACTED]"),
  });
  const pair = async (name = "phone") => {
    const paired = await devices.redeemPairing((await devices.createPairing()).code, name);
    if (!paired) throw new Error("no pairing");
    return paired.credential;
  };
  const check = (cookie: string, runId: string, reason: unknown) =>
    handler.handle(request("POST", `/api/runs/${runId}/cancel/check`, cookie, { reason }));
  const decide = (cookie: string, runId: string, flow: unknown) =>
    handler.handle(request("POST", `/api/runs/${runId}/cancel/decide`, cookie, { flow }));
  return { handler, audit, pair, check, decide };
}

describe("cancel from the web UI", () => {
  test("tne3n_web_check_then_decide_cancels_the_run", async () => {
    const { api, canceled } = fakeApi();
    const { pair, check, decide, handler } = await setup(api);
    const cookie = await pair();
    expect(bodyOf(await handler.handle(request("GET", "/api/me", cookie))).canCancel).toBe(true);
    const checked = await check(cookie, "r_run", "  wrong approach  ");
    expect(checked.status).toBe(200);
    const flow = bodyOf(checked).flow;
    expect(bodyOf(checked).task).toBe("TASK-1");
    // The check writes nothing.
    expect(canceled).toEqual([]);
    const decided = await decide(cookie, "r_run", flow);
    expect(decided.status).toBe(200);
    expect(bodyOf(decided).answer).toMatchObject({
      ok: true,
      status: "canceled",
      task: { key: "TASK-1", still_open: true },
      branch: "kodel/r_run",
      worktree: "/w/r_run",
    });
    expect(canceled).toEqual([{ runId: "r_run", reason: "wrong approach" }]);

    // A paused run, or one at a gate, is shown as waiting and can be canceled as well.
    const gate = bodyOf(await check(cookie, "r_gate", "stop"));
    expect((await decide(cookie, "r_gate", gate.flow)).status).toBe(200);
  });

  test("tne3n_web_decide_without_a_check_or_with_a_used_or_foreign_flow_is_refused", async () => {
    const { api, canceled } = fakeApi();
    const { pair, check, decide } = await setup(api);
    const cookie = await pair();
    const other = await pair("laptop");

    const none = await decide(cookie, "r_run", 999);
    expect(none.status).toBe(409);
    expect(bodyOf(none).code).toBe("not_checked");

    const flow = bodyOf(await check(cookie, "r_run", "why")).flow;
    // Another run's cancel, or another device's, does not take this flow; the flow is gone after.
    expect((await decide(cookie, "r_gate", flow)).status).toBe(409);
    const flow2 = bodyOf(await check(cookie, "r_run", "why")).flow;
    expect((await decide(other, "r_run", flow2)).status).toBe(409);

    const flow3 = bodyOf(await check(cookie, "r_run", "why")).flow;
    expect((await decide(cookie, "r_run", flow3)).status).toBe(200);
    const again = await decide(cookie, "r_run", flow3);
    expect(again.status).toBe(409);
    expect(bodyOf(again).code).toBe("not_checked");
    expect(canceled).toHaveLength(1);
  });

  test("tne3n_web_read_only_server_refuses_cancel", async () => {
    const { api } = fakeApi(false);
    const { pair, check, decide, handler } = await setup(api);
    const cookie = await pair();
    expect(bodyOf(await handler.handle(request("GET", "/api/me", cookie))).canCancel).toBe(false);
    for (const answer of [await check(cookie, "r_run", "why"), await decide(cookie, "r_run", 1)]) {
      expect(answer.status).toBe(403);
      expect(bodyOf(answer).code).toBe("read_only");
    }
  });

  test("tne3n_web_empty_or_too_long_reason_is_refused", async () => {
    const { api } = fakeApi();
    const { pair, check } = await setup(api);
    const cookie = await pair();
    for (const reason of ["", "   \n ", "x".repeat(2_001)]) {
      const answer = await check(cookie, "r_run", reason);
      expect(answer.status).toBe(400);
      expect(bodyOf(answer).code).toBe("bad_reason");
    }
    expect((await check(cookie, "r_run", undefined)).status).toBe(400);
    expect((await check(cookie, "r_run", "x".repeat(2_000))).status).toBe(200);
  });

  test("tne3n_web_finished_run_gets_an_error_answer", async () => {
    const { api, canceled } = fakeApi();
    const { pair, check } = await setup(api);
    const cookie = await pair();
    for (const id of ["r_done", "r_gone"]) {
      const answer = await check(cookie, id, "why");
      expect(answer.status).toBe(409);
      expect(bodyOf(answer)).toMatchObject({ ok: false, code: "run_finished" });
      expect(String(bodyOf(answer).message)).toMatch(/only a running or paused run/);
    }
    const unknown = await check(cookie, "r_nope", "why");
    expect(unknown.status).toBe(404);
    expect(canceled).toEqual([]);
  });

  test("tne3n_web_refused_cancel_is_an_error_answer", async () => {
    const { api } = fakeApi();
    api.cancel = async () => ({ ok: false, code: "RUN_FINISHED", message: "already completed" });
    const { pair, check, decide, audit } = await setup(api);
    const cookie = await pair();
    const flow = bodyOf(await check(cookie, "r_run", "why")).flow;
    const answer = await decide(cookie, "r_run", flow);
    expect(answer.status).toBe(409);
    expect(bodyOf(answer)).toMatchObject({ ok: false, code: "RUN_FINISHED" });
    expect(audit.at(-1)).toContain("refused (already completed)");
  });

  test("tne3n_web_cancel_writes_an_audit_line_with_the_device", async () => {
    const { api } = fakeApi();
    const { pair, check, decide, audit } = await setup(api);
    const cookie = await pair("my phone");
    const flow = bodyOf(await check(cookie, "r_run", "the plan\nwas wrong")).flow;
    // Only the cancel itself is audited, not its check.
    const before = audit.length;
    await decide(cookie, "r_run", flow);
    expect(audit.length).toBe(before + 1);
    const line = audit.at(-1) ?? "";
    expect(line).toMatch(
      /^device \S+ "my phone": cancel r_run \(reason: the plan was wrong\): written$/,
    );
  });

  test("tne3n_web_secret_in_the_reason_is_redacted_in_the_audit_line", async () => {
    const { api, canceled } = fakeApi();
    const { pair, check, decide, audit } = await setup(api);
    const cookie = await pair();
    // Made up, and put together here so that a secret scanner does not take the source for a key.
    const secret = ["sk", "ABCDEFGHIJKLMNOP1234"].join("-");
    const flow = bodyOf(await check(cookie, "r_run", `leaked ${secret}`)).flow;
    await decide(cookie, "r_run", flow);
    expect(audit.join("\n")).not.toContain(secret);
    expect(audit.at(-1)).toContain("leaked [REDACTED]");
    // The run's own journal redacts on its own write path; the cancel gets the person's words.
    expect(canceled[0]?.reason).toBe(`leaked ${secret}`);
  });

  test("tne3n_project_api_cancels_through_the_shared_command", async () => {
    const reasons: string[] = [];
    const ports: CancelPorts = {
      open: async (runId) =>
        runId === "r_run"
          ? {
              cancel: async ({ reason }) => {
                reasons.push(reason ?? "");
                return {
                  ok: true,
                  state: { status: "canceled", taskKey: "TASK-1" },
                } as unknown as Decision;
              },
              location: async () => ({ path: "/w/r_run", branch: "kodel/r_run" }),
            }
          : undefined,
      withWorkerStartLock: (fn) => fn(),
      finishWorkers: async () => undefined,
    };
    const host = {} as Parameters<typeof projectApi>[0];
    const api = projectApi(
      host,
      "/p",
      {
        check: async () => ({ ok: false, message: "" }) as never,
        decide: async () => ({}) as never,
      },
      undefined,
      undefined,
      async () => ports,
    );
    expect(await api.cancel?.("r_run", "  why ")).toMatchObject({
      ok: true,
      task: { key: "TASK-1", still_open: true },
      branch: "kodel/r_run",
      remove_commands: ["git worktree remove /w/r_run", "git branch -d kodel/r_run"],
    });
    expect(reasons).toEqual(["why"]);
    expect(await api.cancel?.("r_nope", "why")).toMatchObject({ ok: false, code: "UNKNOWN_RUN" });
  });
});
