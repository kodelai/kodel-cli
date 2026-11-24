/**
 * The web UI (T-44): a device is paired once with a code only a person at a terminal is shown, and then
 * opens the runs and decides on them with its cookie. Every rule is tested on the request handler, with
 * no port; the decisions are tested on real runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost, type LocalRun } from "@kodel-ai/local";
import { runCli } from "../src/cli";
import { createDecisionTools } from "../src/tui/decide";
import { clientAddress } from "../src/web/address";
import { demoApi, projectApi } from "../src/web/command";
import { DeviceStore } from "../src/web/devices";
import {
  COOKIE,
  createHandler,
  diffRows,
  type Handler,
  type WebApi,
  type WebRequest,
  type WebResponse,
} from "../src/web/handler";
import { startWebServer } from "../src/web/server";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-web-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ASSETS = { html: "<html></html>", js: "app()", css: "body{}" };
const HOST = "127.0.0.1:4317";

function request(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; origin?: string | null; ip?: string } = {},
): WebRequest {
  const url = new URL(path, `http://${HOST}`);
  const headers: WebRequest["headers"] = { host: HOST };
  if (options.cookie !== undefined) headers.cookie = `${COOKIE}=${options.cookie}`;
  if (method !== "GET") {
    if (options.origin !== null) headers.origin = options.origin ?? `http://${HOST}`;
    headers["content-type"] = "application/json";
  }
  return {
    method,
    path: url.pathname,
    query: url.searchParams,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ip: options.ip ?? "10.0.0.1",
  };
}

const bodyOf = (r: WebResponse) => JSON.parse(String(r.body)) as Record<string, unknown>;

function credentialOf(r: WebResponse): string {
  const set = r.headers["set-cookie"] ?? "";
  const found = new RegExp(`${COOKIE}=([^;]*)`).exec(set);
  if (!found?.[1]) throw new Error(`no cookie in ${set}`);
  return found[1];
}

async function setup(api: WebApi, clock?: () => number) {
  const devices = new DeviceStore(join(dir, "web"), clock ? { clock } : {});
  const audit: string[] = [];
  const handler = createHandler({
    api,
    devices,
    assets: ASSETS,
    secureCookie: false,
    audit: (line) => audit.push(line),
    ...(clock ? { clock } : {}),
  });
  const pair = async (name = "phone") => {
    const { code } = await devices.createPairing();
    const answer = await handler.handle(request("POST", "/api/pair", { body: { code, name } }));
    expect(answer.status).toBe(200);
    return credentialOf(answer);
  };
  return { devices, handler, audit, pair };
}

describe("devices", () => {
  test("t44_pairing_code_is_single_use", async () => {
    const store = new DeviceStore(join(dir, "web"));
    const { code } = await store.createPairing();
    expect(await store.redeemPairing(code, "phone")).toBeDefined();
    expect(await store.redeemPairing(code, "other")).toBeUndefined();
    expect((await store.list()).map((d) => d.name)).toEqual(["phone"]);
  });

  test("t44_pairing_code_expires", async () => {
    let now = 1_000_000;
    const store = new DeviceStore(join(dir, "web"), { clock: () => now });
    const { code } = await store.createPairing(60_000);
    now += 60_001;
    expect(await store.redeemPairing(code, "phone")).toBeUndefined();
  });

  test("t44_store_keeps_only_hashes", async () => {
    const store = new DeviceStore(join(dir, "web"));
    const { code } = await store.createPairing();
    const unused = (await store.createPairing()).code;
    const paired = await store.redeemPairing(code, "phone");
    const token = paired?.credential.split(".")[1] ?? "";
    expect(token.length).toBeGreaterThan(40);
    const text = await readFile(store.file, "utf8");
    for (const secret of [code, unused, token]) expect(text).not.toContain(secret);
    expect(await store.verify(paired?.credential)).toMatchObject({ name: "phone" });
  });

  test("t44_revoked_device_is_refused", async () => {
    const store = new DeviceStore(join(dir, "web"));
    const paired = await store.redeemPairing((await store.createPairing()).code, "phone");
    const id = paired?.device.id ?? "";
    expect(await store.revoke(id)).toBe(true);
    expect(await store.verify(paired?.credential)).toBeUndefined();
  });

  test("t44_wrong_token_of_a_known_device_is_refused", async () => {
    const store = new DeviceStore(join(dir, "web"));
    const paired = await store.redeemPairing((await store.createPairing()).code, "phone");
    const id = paired?.device.id ?? "";
    expect(await store.verify(`${id}.not-the-token`)).toBeUndefined();
    expect(await store.verify(id)).toBeUndefined();
    expect(await store.verify(undefined)).toBeUndefined();
  });

  test("t44_device_file_of_a_newer_kodel_is_refused", async () => {
    await mkdir(join(dir, "web"), { recursive: true });
    await writeFile(join(dir, "web", "devices.json"), JSON.stringify({ v: 2, devices: [] }));
    const store = new DeviceStore(join(dir, "web"));
    await expect(store.list()).rejects.toThrow(/upgrade kodel/);
  });

  test("t44_device_names_are_one_plain_line", async () => {
    const store = new DeviceStore(join(dir, "web"));
    const paired = await store.redeemPairing(
      (await store.createPairing()).code,
      "\u001b[2Jphone\nname",
    );
    expect(paired?.device.name).toBe("[2Jphonename");
  });
});

describe("handler", () => {
  test("t44_api_refuses_a_request_without_a_paired_device", async () => {
    const { handler } = await setup(await demoApi(Date.now()));
    for (const path of ["/api/sessions", "/api/me", "/api/runs/r_x/detail"]) {
      const answer = await handler.handle(request("GET", path));
      expect(answer.status).toBe(401);
      expect(bodyOf(answer).code).toBe("not_paired");
    }
    const forged = await handler.handle(request("GET", "/api/sessions", { cookie: "abc.def" }));
    expect(forged.status).toBe(401);
    // The page itself carries no data and loads for anyone, so it can show the pairing screen.
    expect((await handler.handle(request("GET", "/"))).status).toBe(200);
  });

  test("t44_paired_device_reads_the_runs", async () => {
    const { handler, pair } = await setup(await demoApi(Date.now()));
    const cookie = await pair();
    const answer = await handler.handle(request("GET", "/api/sessions", { cookie }));
    expect(answer.status).toBe(200);
    expect((bodyOf(answer).sessions as unknown[]).length).toBeGreaterThan(0);
    const me = bodyOf(await handler.handle(request("GET", "/api/me", { cookie })));
    expect(me).toMatchObject({ source: "demo", canDecide: false });
  });

  test("t44_cookie_is_http_only_and_strict", async () => {
    const devices = new DeviceStore(join(dir, "web"));
    const handler = createHandler({
      api: await demoApi(Date.now()),
      devices,
      assets: ASSETS,
      secureCookie: true,
      audit: () => undefined,
    });
    const { code } = await devices.createPairing();
    const answer = await handler.handle(
      request("POST", "/api/pair", { body: { code, name: "p" } }),
    );
    const set = answer.headers["set-cookie"] ?? "";
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Secure");
  });

  test("t44_write_from_another_site_is_refused", async () => {
    const { handler, pair } = await setup(await demoApi(Date.now()));
    const cookie = await pair();
    const body = { node: "n", attempt: 1, severity: "major", location: "n", description: "x" };
    for (const origin of ["https://evil.example", null]) {
      const answer = await handler.handle(
        request("POST", "/api/runs/r_x/comments", { cookie, body, origin }),
      );
      expect(answer.status).toBe(403);
      expect(bodyOf(answer).code).toBe("foreign_origin");
    }
    const form = request("POST", "/api/runs/r_x/comments", { cookie, body });
    form.headers["content-type"] = "application/x-www-form-urlencoded";
    expect((await handler.handle(form)).status).toBe(415);
  });

  test("t44_public_address_is_an_allowed_origin", async () => {
    const devices = new DeviceStore(join(dir, "web"));
    const handler = createHandler({
      api: await demoApi(Date.now()),
      devices,
      assets: ASSETS,
      publicUrl: new URL("https://kodel.example.com"),
      secureCookie: true,
      audit: () => undefined,
    });
    const { code } = await devices.createPairing();
    const answer = await handler.handle(
      request("POST", "/api/pair", {
        body: { code, name: "p" },
        origin: "https://kodel.example.com",
      }),
    );
    expect(answer.status).toBe(200);
  });

  test("t44_pairing_attempts_are_limited", async () => {
    const { handler, devices } = await setup(await demoApi(Date.now()));
    for (let i = 0; i < 10; i++) {
      const wrong = await handler.handle(
        request("POST", "/api/pair", { body: { code: `wrong${i}`, name: "x" } }),
      );
      expect(wrong.status).toBe(403);
    }
    // Even the right code is refused from that address until the window passes.
    const { code } = await devices.createPairing();
    const answer = await handler.handle(
      request("POST", "/api/pair", { body: { code, name: "x" } }),
    );
    expect(answer.status).toBe(429);
    const elsewhere = await handler.handle(
      request("POST", "/api/pair", { body: { code, name: "x" }, ip: "10.0.0.2" }),
    );
    expect(elsewhere.status).toBe(200);
  });

  test("t44_every_answer_carries_the_security_headers", async () => {
    const { handler } = await setup(await demoApi(Date.now()));
    for (const path of ["/", "/app.js", "/api/sessions", "/nothing"]) {
      const answer = await handler.handle(request("GET", path));
      expect(answer.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(answer.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(answer.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  test("t44_demo_writes_no_decision", async () => {
    const { handler, pair } = await setup(await demoApi(Date.now()));
    const cookie = await pair();
    const answer = await handler.handle(
      request("POST", "/api/runs/r_x/check", {
        cookie,
        body: { ref: { kind: "gate", node: "n" }, decision: "approve" },
      }),
    );
    expect(answer.status).toBe(403);
  });

  test("t44_diff_sent_out_is_redacted", () => {
    const key = `AKIA${"A".repeat(16)}`;
    const diff = diffRows("a.ts", {
      kind: "text",
      text: `@@ -1,1 +1,1 @@\n-const k = 1;\n+const k = "${key}";\n`,
      truncated: false,
    });
    expect(JSON.stringify(diff)).not.toContain(key);
    if (diff.kind !== "rows") throw new Error("no rows");
    expect(diff.rows.map((r) => r.place)).toEqual([undefined, "a.ts:1 (removed line)", "a.ts:1"]);
  });
});

describe("hardening", () => {
  test("t44_diff_uses_the_projects_redaction", () => {
    const diff = diffRows(
      "a.ts",
      { kind: "text", text: "@@ -1,1 +1,1 @@\n-a\n+PROJECT-SECRET-42\n", truncated: false },
      (t) => t.replaceAll("PROJECT-SECRET-42", "[REDACTED]"),
    );
    expect(JSON.stringify(diff)).not.toContain("PROJECT-SECRET-42");
  });

  test("t44_revoked_device_loses_its_open_event_stream", async () => {
    const { devices, handler, pair } = await setup(await demoApi(Date.now()));
    const cookie = await pair();
    const web = startWebServer({ handler, api: await demoApi(Date.now()), pollMs: 20 });
    await new Promise<void>((resolve) => web.server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = web.server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
        headers: { cookie: `${COOKIE}=${cookie}` },
      });
      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("no stream");
      await reader.read();
      const [device] = await devices.list();
      await devices.revoke(device?.id ?? "");
      // The stream ends within a few ticks instead of listening on.
      const ended = (async () => {
        for (;;) if ((await reader.read()).done) return true;
      })();
      expect(
        await Promise.race([ended, new Promise((r) => setTimeout(() => r(false), 3_000))]),
      ).toBe(true);
    } finally {
      await web.close();
    }
  });

  test("t44_a_person_and_the_server_never_overwrite_each_others_devices", async () => {
    // Two stores on one file, as the server and a person's `kodel web` are: every change is kept.
    const a = new DeviceStore(join(dir, "web"));
    const b = new DeviceStore(join(dir, "web"));
    await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? a : b).createPairing()));
    const file = JSON.parse(await readFile(join(dir, "web", "devices.json"), "utf8")) as {
      pairings: unknown[];
    };
    expect(file.pairings).toHaveLength(5);
    const paired = await a.redeemPairing((await b.createPairing()).code, "phone");
    await Promise.all([a.revoke(paired?.device.id ?? ""), b.verify(paired?.credential)]);
    expect(await a.list()).toEqual([]);
  });

  test("t44_wrong_tries_behind_a_local_proxy_count_per_client", () => {
    const req = (peer: string, forwarded?: string) => ({
      socket: { remoteAddress: peer },
      headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
    });
    expect(clientAddress(req("10.0.0.5") as never)).toBe("10.0.0.5");
    // A forwarded address is believed only from the loopback, where only a local proxy sends it.
    expect(clientAddress(req("10.0.0.5", "1.2.3.4") as never)).toBe("10.0.0.5");
    expect(clientAddress(req("127.0.0.1", "9.9.9.9, 100.64.0.7") as never)).toBe("100.64.0.7");
    expect(clientAddress(req("::1") as never)).toBe("::1");
  });
});

describe("decisions on real runs", () => {
  const ONE = [
    "name: one",
    "nodes:",
    "  - { slug: write, kind: agent, prompt: write }",
    "  - slug: approve",
    "    kind: human",
    "    prompt: fine?",
    "    results:",
    "      columns:",
    "        severity: { enum: [blocker, critical, major, minor, info] }",
    "        location: location",
    "        description: text",
    "edges:",
    "  - { from: write, to: approve }",
    "  - { from: approve, to: write, when: rejected }",
    "",
  ].join("\n");

  let root: string;
  beforeEach(async () => {
    root = join(dir, "project");
    await mkdir(join(root, ".kodel", "pipelines"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("commit", "-q", "--allow-empty", "-m", "initial");
    await writeFile(join(root, ".kodel", "pipelines", "one.yaml"), ONE);
    await writeFile(join(root, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
  });

  async function atGate(): Promise<{
    h: LocalPipelineHost;
    run: LocalRun;
    web: Handler;
    pair: (name?: string) => Promise<string>;
    audit: string[];
  }> {
    const h = new LocalPipelineHost({ root, heartbeatMs: 0 });
    const run = (await h.start({ pipeline: "one", task: "t", restart: false })).run as LocalRun;
    await run.completeStep("write", 1);
    await run.waitForRest(5_000);
    const tools = createDecisionTools(h);
    const { handler, pair, audit } = await setup(projectApi(h, root, tools));
    return { h, run, web: handler, pair, audit };
  }

  const REF = { kind: "gate", node: "approve", attempt: 1 };

  test("t44_web_approve_goes_through_the_gate_checks_and_moves_the_run", async () => {
    const { run, web, pair, audit } = await atGate();
    const cookie = await pair();
    const runs = bodyOf(await web.handle(request("GET", "/api/sessions", { cookie })));
    expect(JSON.stringify(runs.sessions)).toContain(run.runId);

    const checked = bodyOf(
      await web.handle(
        request("POST", `/api/runs/${run.runId}/check`, {
          cookie,
          body: { ref: REF, decision: "approve" },
        }),
      ),
    );
    expect(checked.result).toMatchObject({ ok: true });
    const decided = bodyOf(
      await web.handle(
        request("POST", `/api/runs/${run.runId}/decide`, { cookie, body: { flow: checked.flow } }),
      ),
    );
    expect(decided.outcome).toMatchObject({ ok: true });
    await run.waitForRest(5_000);
    expect((await run.state()).status).toBe("completed");
    expect(audit.some((l) => l.includes(`approve ${run.runId} approve#1: written`))).toBe(true);

    // The same check cannot be used twice.
    const again = await web.handle(
      request("POST", `/api/runs/${run.runId}/decide`, { cookie, body: { flow: checked.flow } }),
    );
    expect(again.status).toBe(409);
  });

  test("t44_finished_run_still_shows_its_steps", async () => {
    const { run, web, pair } = await atGate();
    const cookie = await pair();
    const checked = bodyOf(
      await web.handle(
        request("POST", `/api/runs/${run.runId}/check`, {
          cookie,
          body: { ref: REF, decision: "approve" },
        }),
      ),
    );
    await web.handle(
      request("POST", `/api/runs/${run.runId}/decide`, { cookie, body: { flow: checked.flow } }),
    );
    await run.waitForRest(5_000);
    expect((await run.state()).status).toBe("completed");
    const card = await web.handle(request("GET", `/api/runs/${run.runId}/detail`, { cookie }));
    expect(card.status).toBe(200);
    const detail = bodyOf(card).detail as { visits: { slug: string }[] };
    expect(detail.visits.map((v) => v.slug)).toEqual(["write", "approve"]);
  });

  test("t44_web_reject_needs_a_reason_and_sends_the_run_back", async () => {
    const { run, web, pair } = await atGate();
    const cookie = await pair();
    const bare = bodyOf(
      await web.handle(
        request("POST", `/api/runs/${run.runId}/check`, {
          cookie,
          body: { ref: REF, decision: "reject" },
        }),
      ),
    );
    expect(bare.result).toMatchObject({ ok: false, needsReason: true });
    const checked = bodyOf(
      await web.handle(
        request("POST", `/api/runs/${run.runId}/check`, {
          cookie,
          body: { ref: REF, decision: "reject", reason: "the tests are missing" },
        }),
      ),
    );
    expect(checked.result).toMatchObject({ ok: true });
    const decided = bodyOf(
      await web.handle(
        request("POST", `/api/runs/${run.runId}/decide`, { cookie, body: { flow: checked.flow } }),
      ),
    );
    expect(decided.outcome).toMatchObject({ ok: true });
    await run.waitForRest(5_000);
    const journal = JSON.stringify(await run.journal());
    expect(journal).toContain("the tests are missing");
    expect((await run.state()).active.map((v) => v.node)).toContain("write");
  });

  test("t44_a_check_is_the_devices_own", async () => {
    const { run, web, pair } = await atGate();
    const mine = await pair("mine");
    const other = await pair("other");
    const checked = bodyOf(
      await web.handle(
        request("POST", `/api/runs/${run.runId}/check`, {
          cookie: mine,
          body: { ref: REF, decision: "approve" },
        }),
      ),
    );
    const answer = await web.handle(
      request("POST", `/api/runs/${run.runId}/decide`, {
        cookie: other,
        body: { flow: checked.flow },
      }),
    );
    expect(answer.status).toBe(409);
    expect((await run.state()).status).not.toBe("completed");
  });

  test("t44_web_comment_is_a_row_of_the_gate", async () => {
    const { run, web, pair } = await atGate();
    const cookie = await pair();
    const answer = await web.handle(
      request("POST", `/api/runs/${run.runId}/comments`, {
        cookie,
        body: {
          node: "approve",
          attempt: 1,
          severity: "major",
          location: "src/a.ts:3",
          description: "name it",
        },
      }),
    );
    expect(answer.status).toBe(200);
    const detail = bodyOf(
      await web.handle(request("GET", `/api/runs/${run.runId}/detail`, { cookie })),
    ).detail as { comments: unknown[] };
    expect(detail.comments).toEqual([
      { severity: "major", location: "src/a.ts:3", description: "name it" },
    ]);
  });
});

describe("commands", () => {
  async function cli(interactive: boolean, ...args: string[]) {
    let out = "";
    let err = "";
    const code = await runCli(args, {
      cwd: dir,
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
      interactive,
      environment: { KODEL_STATE_DIR: join(dir, "state") },
      select: async () => [],
      confirm: async () => true,
    });
    return { code, out, err };
  }

  test("t44_pairing_code_is_shown_only_to_a_person", async () => {
    const refused = await cli(false, "web", "pair");
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("for a person");
    const shown = await cli(true, "web", "pair");
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("#pair=");
  });

  test("t44_revoke_is_for_a_person", async () => {
    const store = new DeviceStore(join(dir, "state", "web"));
    const paired = await store.redeemPairing((await store.createPairing()).code, "phone");
    const id = paired?.device.id ?? "";
    expect((await cli(false, "web", "revoke", id)).code).not.toBe(0);
    expect((await cli(false, "web", "devices")).out).toContain("phone");
    expect((await cli(true, "web", "revoke", id)).code).toBe(0);
    expect((await cli(false, "web", "devices")).out).toContain("No devices are paired");
  });
});
