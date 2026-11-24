/**
 * `kodel web --mcp`: the manager's tools over Streamable HTTP at `/mcp`, for an MCP client on another
 * machine (T-44). A call carries a token a person made at a terminal (`Authorization: Bearer ...`); a
 * session belongs to the token that opened it and no other; a session left alone is closed. The server
 * a session gets serves the manager role, read-only when the token is: a client that is not on this
 * machine works no run.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { clientAddress } from "./address";
import type { McpToken, TokenStore } from "./tokens";

export const MCP_PATH = "/mcp";
/** A request to the endpoint is a JSON-RPC message or a batch: a few kilobytes, never megabytes. */
export const MCP_MAX_BODY = 4 * 1024 * 1024;
const MAX_SESSIONS = 32;
const IDLE_MS = 30 * 60_000;
/** Wrong tokens tolerated from one address in a minute before it is told to wait. */
const FAILURES_PER_MINUTE = 10;

export interface McpEndpointOptions {
  tokens: TokenStore;
  /** A new server for one session of a token. */
  serverFor(token: McpToken): Promise<McpServer>;
  /** Whether a browser page at `origin` may call; a client that sends no Origin is not a page. */
  originAllowed(origin: string, host: string | undefined): boolean;
  audit(line: string): void;
  clock?: () => number;
  maxSessions?: number;
  idleMs?: number;
  /** How often idle sessions and those of revoked tokens are closed. */
  sweepMs?: number;
}

export interface McpEndpoint {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** How many sessions are open. */
  size(): number;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  token: McpToken;
  lastAt: number;
}

function refuse(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res
    .writeHead(status, { "content-type": "application/json", ...headers })
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MCP_MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(
          chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
      } catch {
        reject(new Error("not JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** The tools a body calls, for the audit log: the names only, never the arguments. */
function toolCalls(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((m) => {
    if (typeof m !== "object" || m === null) return [];
    const r = m as Record<string, unknown>;
    if (r.method !== "tools/call" || typeof r.params !== "object" || r.params === null) return [];
    const name = (r.params as Record<string, unknown>).name;
    return typeof name === "string" ? [name.slice(0, 80)] : [];
  });
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export function createMcpEndpoint(options: McpEndpointOptions): McpEndpoint {
  const clock = options.clock ?? Date.now;
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const idleMs = options.idleMs ?? IDLE_MS;
  const sessions = new Map<string, Session>();
  const failures = new Map<string, number[]>();

  const end = async (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await s.transport.close().catch(() => undefined);
    await s.server.close().catch(() => undefined);
  };

  const sweep = async () => {
    const now = clock();
    // A session whose token was revoked is closed, with its open stream: the next call would be refused anyway.
    const live =
      sessions.size === 0
        ? undefined
        : await options.tokens.list().then(
            (list) => new Set(list.map((t) => t.id)),
            () => undefined,
          );
    for (const [id, s] of sessions) {
      if (now - s.lastAt > idleMs || (live !== undefined && !live.has(s.token.id))) await end(id);
    }
    for (const [ip, times] of failures) {
      const recent = times.filter((t) => now - t < 60_000);
      if (recent.length === 0) failures.delete(ip);
      else failures.set(ip, recent);
    }
  };
  const timer = setInterval(() => void sweep(), options.sweepMs ?? 60_000);
  timer.unref?.();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = header(req, "origin");
    if (origin !== undefined && !options.originAllowed(origin, header(req, "host"))) {
      refuse(res, 403, "Requests from other sites are refused.");
      return;
    }
    const ip = clientAddress(req);
    const now = clock();
    const failed = (failures.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (failed.length >= FAILURES_PER_MINUTE) {
      refuse(res, 429, "Too many wrong tokens; wait a minute.", { "retry-after": "60" });
      return;
    }
    const bearer = /^Bearer\s+(\S+)$/i.exec(header(req, "authorization") ?? "")?.[1];
    const token = await options.tokens.verify(bearer).catch(() => undefined);
    if (!token) {
      failures.set(ip, [...failed, now]);
      refuse(res, 401, "A token from `kodel web token add` is needed.", {
        "www-authenticate": 'Bearer realm="kodel"',
      });
      return;
    }

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readJson(req);
      } catch (error) {
        refuse(
          res,
          (error as Error).message === "too large" ? 413 : 400,
          "The body is not understood.",
        );
        return;
      }
    }

    const sid = header(req, "mcp-session-id");
    if (sid !== undefined) {
      const s = sessions.get(sid);
      // A session of another token is answered as one that does not exist: nothing about it leaks.
      if (!s || s.token.id !== token.id) {
        refuse(res, 404, "No such session; connect again.");
        return;
      }
      s.lastAt = now;
      s.token = token;
      for (const tool of toolCalls(body)) {
        options.audit(`token ${token.id} "${token.name}" called ${tool}`);
      }
      await s.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(body)) {
      refuse(res, 400, "No session: send initialize first.");
      return;
    }
    if (sessions.size >= maxSessions) await sweep();
    if (sessions.size >= maxSessions) {
      refuse(res, 503, "Too many sessions are open; try again later.");
      return;
    }
    const server = await options.serverFor(token);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, token, lastAt: clock() });
        options.audit(
          `token ${token.id} "${token.name}" opened an MCP session${token.readOnly ? " (read-only)" : ""}`,
        );
      },
      onsessionclosed: (id) => {
        void end(id);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined) sessions.delete(id);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  return {
    handle: (req, res) =>
      handle(req, res).catch(() => {
        if (!res.headersSent) refuse(res, 500, "The request failed.");
        else res.end();
      }),
    size: () => sessions.size,
    async close() {
      clearInterval(timer);
      for (const id of [...sessions.keys()]) await end(id);
    },
  };
}
