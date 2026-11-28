/**
 * The web UI's Start and Stop agent (mstart): a write of another site, a body that is not JSON and a device
 * that is not paired are refused; the server asks for the confirmation and does the thing at the second
 * call only; a start goes past exactly the warnings the person was shown; the buttons need no key of
 * `decisions.agent`. Every rule is tested on the handler function, with no port.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ForcedWarning, KodelError, type TaskService } from "@kodel-ai/pipeline-core";
import type { ActingPorts } from "../src/manager-ports";
import type { ManualCheck, ManualStartResult } from "../src/manual-start";
import { webActing } from "../src/web/acting";
import { loadAssets } from "../src/web/assets";
import { demoApi } from "../src/web/command";
import { DeviceStore } from "../src/web/devices";
import { createHandler, type WebApi, type WebRequest, type WebResponse } from "../src/web/handler";
import type { WorkerStatus } from "../src/worker-launcher";
import { FakeLauncher } from "./fake-launcher";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-web-start-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const HOST = "127.0.0.1:4317";
const RUN = "r_0mwwhh8jl_8hsz";
const bodyOf = (r: WebResponse) => JSON.parse(String(r.body)) as Record<string, unknown>;

async function paired(api: WebApi) {
  const devices = new DeviceStore(join(dir, "web"));
  const audit: string[] = [];
  const web = createHandler({
    api,
    devices,
    assets: { html: "", js: "", css: "" },
    secureCookie: false,
    audit: (line) => audit.push(line),
  });
  const pair = async (name: string) => {
    const { code } = await devices.createPairing();
    const answer = await web.handle({
      method: "POST",
      path: "/api/pair",
      query: new URLSearchParams(),
      headers: { host: HOST, origin: `http://${HOST}`, "content-type": "application/json" },
      body: JSON.stringify({ code, name }),
      ip: "127.0.0.1",
    });
    return (answer.headers["set-cookie"] ?? "").split(";")[0] ?? "";
  };
  const callAs =
    (cookie: string) =>
    (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string | undefined> = {},
    ): Promise<WebResponse> => {
      const request: WebRequest = {
        method,
        path,
        query: new URLSearchParams(),
        headers: {
          host: HOST,
          origin: `http://${HOST}`,
          ...(cookie === "" ? {} : { cookie }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? "" : JSON.stringify(body),
        ip: "127.0.0.1",
      };
      return web.handle(request);
    };
  const cookie = await pair("phone");
  return { call: callAs(cookie), callAs, pair, audit };
}

interface Fakes {
  api: WebApi;
  checks: string[];
  starts: { key: string; pipeline?: string; force: ForcedWarning[] }[];
  stops: string[];
}

async function fakes(
  over: { check?: ManualCheck; start?: ManualStartResult } = {},
): Promise<Fakes> {
  const checks: string[] = [];
  const starts: Fakes["starts"] = [];
  const stops: string[] = [];
  const check: ManualCheck = over.check ?? {
    ok: true,
    pipelines: ["dev", "docs"],
    warnings: [],
  };
  const api: WebApi = {
    ...(await demoApi(Date.now())),
    source: "project",
    startTask: {
      async check(key) {
        checks.push(key);
        return check;
      },
      async start(input) {
        starts.push(input);
        return (
          over.start ?? {
            status: "started",
            run_id: RUN,
            agent: `kw-${RUN}`,
            pipeline: input.pipeline ?? "dev",
            task_key: input.key,
          }
        );
      },
    },
    async stopAgent(runId) {
      stops.push(runId);
      return {
        status: "stopped",
        agent: `kw-${runId}`,
        run_id: runId,
        note: "n",
        journaled: false,
      };
    },
  };
  return { api, checks, starts, stops };
}

describe("mstart the web UI's start and stop", () => {
  test("mstart_web_origin_and_content_type", async () => {
    const f = await fakes();
    const { call, callAs } = await paired(f.api);
    const routes = [
      ["/api/tasks/T-1/start", {}],
      [`/api/runs/${RUN}/stop-agent`, {}],
    ] as const;
    for (const [path, body] of routes) {
      expect((await call("POST", path, body, { origin: "http://evil.example" })).status).toBe(403);
      expect((await call("POST", path, body, { origin: undefined })).status).toBe(403);
      expect((await call("POST", path, body, { "content-type": "text/plain" })).status).toBe(415);
      expect((await callAs("")("POST", path, body)).status).toBe(401);
      expect((await callAs("kodel_device=x.y")("POST", path, body)).status).toBe(401);
    }
    expect(f.checks).toEqual([]);
    expect(f.starts).toEqual([]);
    expect(f.stops).toEqual([]);
  });

  test("mstart_web_confirm_and_audit", async () => {
    const f = await fakes();
    const { call, callAs, pair, audit } = await paired(f.api);
    const first = await call("POST", "/api/tasks/T-1/start", {});
    expect(bodyOf(first)).toMatchObject({ step: "confirm", pipelines: ["dev", "docs"] });
    // The first call starts nothing.
    expect(f.starts).toEqual([]);
    const flow = bodyOf(first).flow as number;
    // Another device cannot use the flow; a flow of another task cannot be used either.
    const other = callAs(await pair("tablet"));
    expect((await other("POST", "/api/tasks/T-1/start", { flow })).status).toBe(409);
    const second = await call("POST", "/api/tasks/T-2/start", { flow });
    expect(second.status).toBe(409);
    expect(f.starts).toEqual([]);
    // A flow is used once, so ask again.
    const again = bodyOf(await call("POST", "/api/tasks/T-1/start", {})).flow as number;
    const done = await call("POST", "/api/tasks/T-1/start", { flow: again, pipeline: "docs" });
    expect(bodyOf(done)).toMatchObject({
      step: "done",
      result: { status: "started", run_id: RUN, pipeline: "docs" },
    });
    expect(f.starts).toEqual([{ key: "T-1", pipeline: "docs", force: [] }]);
    expect((await call("POST", "/api/tasks/T-1/start", { flow: again })).status).toBe(409);
    expect(audit.some((l) => /^device \S+ started T-1 \(run r_0mwwhh8jl_8hsz\)$/.test(l))).toBe(
      true,
    );
  });

  test("mstart_web_stop_confirm_and_audit", async () => {
    const f = await fakes();
    const { call, callAs, pair, audit } = await paired(f.api);
    const first = bodyOf(await call("POST", `/api/runs/${RUN}/stop-agent`, {}));
    expect(first.step).toBe("confirm");
    expect(f.stops).toEqual([]);
    const other = callAs(await pair("tablet"));
    expect((await other("POST", `/api/runs/${RUN}/stop-agent`, { flow: first.flow })).status).toBe(
      409,
    );
    expect(
      (await call("POST", "/api/runs/r_0mwwhh8jl_aaaa/stop-agent", { flow: first.flow })).status,
    ).toBe(409);
    const again = bodyOf(await call("POST", `/api/runs/${RUN}/stop-agent`, {})).flow;
    const done = bodyOf(await call("POST", `/api/runs/${RUN}/stop-agent`, { flow: again }));
    expect(done).toMatchObject({ step: "done", result: { status: "stopped" } });
    expect(f.stops).toEqual([RUN]);
    expect(audit.some((l) => /^device \S+ stopped the agent of r_0mwwhh8jl_8hsz$/.test(l))).toBe(
      true,
    );
  });

  test("mstart_web_confirm_shows_warnings", async () => {
    const f = await fakes({
      check: {
        ok: true,
        pipelines: ["dev"],
        warnings: [
          { why: "full", reason: "serve.max_runs is reached: 1 of 1 runs are open" },
          { why: "conflict", reason: "T-1 conflicts with T-9, which has a run" },
        ],
      },
    });
    const { call } = await paired(f.api);
    const first = bodyOf(await call("POST", "/api/tasks/T-1/start", {}));
    expect(first.step).toBe("confirm");
    expect((first.warnings as { why: string }[]).map((w) => w.why)).toEqual(["full", "conflict"]);
    expect(f.starts).toEqual([]);
  });

  test("mstart_web_forced_start", async () => {
    const f = await fakes({
      check: {
        ok: true,
        pipelines: ["dev"],
        warnings: [{ why: "full", reason: "serve.max_runs is reached" }],
      },
    });
    const { call } = await paired(f.api);
    const flow = bodyOf(await call("POST", "/api/tasks/T-1/start", {})).flow;
    await call("POST", "/api/tasks/T-1/start", { flow, force: ["blocked", "conflict"] });
    // Exactly what was shown, whatever the second body says.
    expect(f.starts).toEqual([{ key: "T-1", force: ["full"] }]);
  });

  test("mstart_web_hard_refusal_has_no_second_step", async () => {
    const refused: ManualCheck = {
      ok: false,
      result: { status: "refused", why: "has_run", reason: "T-1 is already started: run r_x" },
    };
    const f = await fakes({ check: refused });
    const { call } = await paired(f.api);
    const answer = bodyOf(await call("POST", "/api/tasks/T-1/start", {}));
    expect(answer).toMatchObject({ step: "done", result: { status: "refused", why: "has_run" } });
    expect(answer.flow).toBeUndefined();
  });

  test("mstart_web_a_new_warning_at_the_second_call_is_an_answer", async () => {
    const f = await fakes({
      start: { status: "refused", why: "full", reason: "serve.max_runs is reached" },
    });
    const { call, audit } = await paired(f.api);
    const flow = bodyOf(await call("POST", "/api/tasks/T-1/start", {})).flow;
    const done = bodyOf(await call("POST", "/api/tasks/T-1/start", { flow }));
    expect(done).toMatchObject({ step: "done", result: { status: "refused", why: "full" } });
    expect(audit.some((l) => l.includes("started"))).toBe(false);
  });

  test("mstart_web_unknown_task_and_bad_pipeline", async () => {
    const f = await fakes();
    f.api.startTask = {
      async check() {
        throw new KodelError("TASK_NOT_FOUND", "there is no task T-1");
      },
      async start() {
        throw new KodelError("INVALID_ARGUMENTS", "there is no pipeline x");
      },
    };
    const { call } = await paired(f.api);
    expect((await call("POST", "/api/tasks/T-1/start", {})).status).toBe(404);
  });

  test("mstart_web_flags_windows_demo", async () => {
    const f = await fakes();
    const me = async (api: WebApi) => bodyOf(await (await paired(api)).call("GET", "/api/me"));
    expect(await me(f.api)).toMatchObject({ canStartTask: true, canStopAgent: true });
    const demo = await me(await demoApi(Date.now()));
    expect(demo).toMatchObject({ canStartTask: false, canStopAgent: false });
    // Without an action wired, the route says so.
    const { call } = await paired(await demoApi(Date.now()));
    expect((await call("POST", "/api/tasks/T-1/start", {})).status).toBe(403);
    expect((await call("POST", `/api/runs/${RUN}/stop-agent`, {})).status).toBe(403);
    const acting = { launcher: async () => new FakeLauncher() } as unknown as ActingPorts;
    expect(webActing({ acting, platform: "win32" })).toEqual({});
    expect(webActing({ acting, platform: "darwin" }).stopAgent).toBeDefined();
  });

  test("mstart_page_has_buttons_by_flags", async () => {
    const { js } = await loadAssets();
    for (const word of ["canStartTask", "canStopAgent", "Stop agent", "Start anyway"]) {
      expect(js).toContain(word);
    }
  });

  test("mstart_web_buttons_need_no_key", async () => {
    // Nothing of `decisions.agent` is an input of the buttons: the acting ports carry no key.
    const launcher = new FakeLauncher();
    const status: WorkerStatus = {
      id: "a_1",
      name: `kw-${RUN}`,
      state: "running",
      label: "running",
      started: 1,
      resumed: [],
      resumes: 0,
    };
    launcher.statusMap.set(RUN, status);
    const noted: unknown[] = [];
    const acting = {
      host: {
        async runSummaries() {
          return [{ meta: { runId: RUN }, state: { status: "running" } }];
        },
        async open() {
          return {
            async noteAgentStopped(input: unknown) {
              noted.push(input);
              return { written: true };
            },
          };
        },
        async withWorkerStartLock<T>(fn: () => Promise<T>) {
          return fn();
        },
      },
      launcher: async () => launcher,
      tasks: {} as TaskService,
      serve: async () => ({ max_workers: 1, max_runs: 1, start: [] }),
      dialog: async () => false,
      root: dir,
      version: "0",
    } as unknown as ActingPorts;
    const api: WebApi = {
      ...(await demoApi(Date.now())),
      source: "project",
      ...webActing({ acting, platform: "darwin" }),
    };
    const { call } = await paired(api);
    expect(bodyOf(await call("GET", "/api/me"))).toMatchObject({
      canStartTask: true,
      canStopAgent: true,
    });
    const flow = bodyOf(await call("POST", `/api/runs/${RUN}/stop-agent`, {})).flow;
    const done = bodyOf(await call("POST", `/api/runs/${RUN}/stop-agent`, { flow }));
    expect(done).toMatchObject({ step: "done", result: { status: "stopped" } });
    expect(launcher.stopped).toEqual([RUN]);
    // A person's click is the record: no event is written to the journal.
    expect(noted).toEqual([]);
  });
});
