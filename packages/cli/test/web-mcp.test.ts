/**
 * The manager's tools over HTTP (T-44): a client carries a token a person made at a terminal; a token is
 * kept only as a hash; a session belongs to the token that opened it; a page of another site, a wrong
 * token and a revoked one are refused; the server a token gets is the manager, read-only when the token is.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runCli } from "../src/cli";
import { createMcpEndpoint, type McpEndpoint } from "../src/web/mcp-http";
import { type McpToken, TokenStore } from "../src/web/tokens";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-web-mcp-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("tokens", () => {
  test("t44_mcp_token_is_kept_only_as_a_hash", async () => {
    const store = new TokenStore(dir);
    const { token, info } = await store.add({ name: "laptop", readOnly: true });
    expect(token.startsWith("kodel_")).toBe(true);
    expect(await readFile(join(dir, "tokens.json"), "utf8")).not.toContain(token.split("_")[2]);
    expect(await store.verify(token)).toMatchObject({ id: info.id, readOnly: true });
    expect(await store.verify(`${token}x`)).toBeUndefined();
    expect(await store.verify(undefined)).toBeUndefined();
    expect(await store.revoke(info.id)).toBe(true);
    expect(await store.verify(token)).toBeUndefined();
  });

  test("t44_mcp_token_file_of_a_newer_kodel_is_refused", async () => {
    await writeFile(join(dir, "tokens.json"), JSON.stringify({ v: 2, tokens: [] }));
    await expect(new TokenStore(dir).list()).rejects.toThrow("upgrade kodel");
  });

  test("t44_mcp_token_is_made_only_by_a_person", async () => {
    const out: string[] = [];
    const code = await runCli(["web", "token", "add", "--name", "laptop"], {
      cwd: dir,
      out: (t) => out.push(t),
      err: (t) => out.push(t),
      interactive: false,
      environment: { KODEL_STATE_DIR: join(dir, "state") },
      select: async () => [],
      confirm: async () => true,
    });
    expect(code).not.toBe(0);
    expect(out.join("")).toContain("for a person");
  });
});

/** An endpoint whose server serves one tool that says which token it was made for. */
async function endpoint(audit: string[] = [], sweepMs?: number) {
  const tokens = new TokenStore(join(dir, "web"));
  const made: McpToken[] = [];
  const mcp: McpEndpoint = createMcpEndpoint({
    tokens,
    serverFor: async (token) => {
      made.push(token);
      const server = new McpServer({ name: "kodel", version: "test" });
      server.registerTool("who", { description: "who" }, async () => ({
        content: [{ type: "text", text: `${token.name}${token.readOnly ? " read-only" : ""}` }],
      }));
      return server;
    },
    originAllowed: (origin, host) => {
      try {
        return new URL(origin).host === host;
      } catch {
        return false;
      }
    },
    audit: (line) => audit.push(line),
    ...(sweepMs === undefined ? {} : { sweepMs }),
  });
  const http: Server = createServer((req, res) => void mcp.handle(req, res));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
  const address = http.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const close = async () => {
    await mcp.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
  return { tokens, made, url, close, mcp };
}

const connect = async (url: URL, token: string | undefined) => {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
};

const post = (url: URL, headers: Record<string, string>, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
};

describe("the /mcp endpoint", () => {
  test("t44_mcp_needs_a_token_and_says_so", async () => {
    const e = await endpoint();
    try {
      const none = await post(e.url, {}, INIT);
      expect(none.status).toBe(401);
      expect(none.headers.get("www-authenticate")).toContain("Bearer");
      expect((await post(e.url, { authorization: "Bearer kodel_x_y" }, INIT)).status).toBe(401);
      expect(e.made).toEqual([]);
    } finally {
      await e.close();
    }
  });

  test("t44_mcp_wrong_tokens_are_limited", async () => {
    const e = await endpoint();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) {
        codes.push((await post(e.url, { authorization: "Bearer kodel_a_b" }, INIT)).status);
      }
      expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(codes.at(-1)).toBe(429);
    } finally {
      await e.close();
    }
  });

  test("t44_mcp_page_of_another_site_is_refused", async () => {
    const e = await endpoint();
    try {
      const { token } = await e.tokens.add({ name: "laptop", readOnly: false });
      const answer = await post(
        e.url,
        { authorization: `Bearer ${token}`, origin: "https://evil.example" },
        INIT,
      );
      expect(answer.status).toBe(403);
      expect(e.made).toEqual([]);
    } finally {
      await e.close();
    }
  });

  test("t44_mcp_session_serves_its_token_and_audits_calls", async () => {
    const audit: string[] = [];
    const e = await endpoint(audit);
    try {
      const { token } = await e.tokens.add({ name: "laptop", readOnly: true });
      const client = await connect(e.url, token);
      const answer = await client.callTool({ name: "who", arguments: {} });
      expect(JSON.stringify(answer.content)).toContain("laptop read-only");
      expect(e.made.map((t) => t.readOnly)).toEqual([true]);
      expect(audit.some((l) => l.includes("opened an MCP session"))).toBe(true);
      expect(audit.some((l) => l.endsWith("called who"))).toBe(true);
      expect(e.mcp.size()).toBe(1);
      await client.close();
    } finally {
      await e.close();
    }
  });

  test("t44_mcp_session_belongs_to_the_token_that_opened_it", async () => {
    const e = await endpoint();
    try {
      const mine = await e.tokens.add({ name: "laptop", readOnly: false });
      const other = await e.tokens.add({ name: "other", readOnly: false });
      const opened = await post(e.url, { authorization: `Bearer ${mine.token}` }, INIT);
      const sid = opened.headers.get("mcp-session-id") ?? "";
      expect(sid).not.toBe("");
      const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
      const stolen = await post(
        e.url,
        { authorization: `Bearer ${other.token}`, "mcp-session-id": sid },
        list,
      );
      expect(stolen.status).toBe(404);
      // Revoked: the session's own token is refused at its next call.
      await e.tokens.revoke(mine.info.id);
      const after = await post(
        e.url,
        { authorization: `Bearer ${mine.token}`, "mcp-session-id": sid },
        list,
      );
      expect(after.status).toBe(401);
    } finally {
      await e.close();
    }
  });
});

describe("revoking a token", () => {
  test("t44_mcp_revoked_token_loses_its_open_sessions", async () => {
    const e = await endpoint([], 20);
    try {
      const { token, info } = await e.tokens.add({ name: "laptop", readOnly: true });
      const client = await connect(e.url, token);
      expect(e.mcp.size()).toBe(1);
      await e.tokens.revoke(info.id);
      for (let i = 0; i < 100 && e.mcp.size() > 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(e.mcp.size()).toBe(0);
      await client.close().catch(() => undefined);
    } finally {
      await e.close();
    }
  });
});

/** The environment of a person's shell: a test run under kodel's own engine carries its mark. */
const withoutEngine = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("KODEL_")));

describe("kodel web --mcp", () => {
  let child: ChildProcess | undefined;
  afterEach(() => {
    child?.kill("SIGKILL");
    child = undefined;
  });

  test("t44_mcp_over_http_serves_the_manager_and_no_worker_tool", async () => {
    const root = join(dir, "project");
    await mkdir(join(root, ".kodel", "pipelines"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, ".kodel", "config.yaml"), "version: 1\n");
    const state = join(dir, "state");
    const tokens = new TokenStore(join(state, "web"));
    const full = await tokens.add({ name: "laptop", readOnly: false });
    const reader = await tokens.add({ name: "phone", readOnly: true });
    const main = join(import.meta.dir, "..", "src", "main.ts");
    child = spawn(
      "bun",
      [main, "--root", root, "web", "--mcp", "--port", "0", "--host", "127.0.0.1"],
      { env: { ...withoutEngine(process.env), KODEL_STATE_DIR: state }, stdio: "pipe" },
    );
    const url = await new Promise<URL>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`no address: ${out}`)), 20_000);
      child?.stdout?.on("data", (d: Buffer) => {
        out += d.toString();
        const m = /MCP \(manager tools\): (\S+)/.exec(out);
        if (m?.[1]) {
          clearTimeout(timer);
          resolve(new URL(m[1]));
        }
      });
      child?.stderr?.on("data", (d: Buffer) => {
        out += d.toString();
      });
    });
    const names = async (token: string) => {
      const client = await connect(url, token);
      const { tools } = await client.listTools();
      await client.close();
      return tools.map((t) => t.name);
    };
    const manager = await names(full.token);
    expect(manager).toContain("manager_inbox");
    expect(manager).toContain("pipeline_propose_change");
    for (const worker of ["pipeline_start", "pipeline_next_step", "pipeline_complete_step"]) {
      expect(manager).not.toContain(worker);
    }
    const readOnly = await names(reader.token);
    expect(readOnly).toContain("manager_inbox");
    expect(readOnly).not.toContain("pipeline_propose_change");
  }, 60_000);
});
