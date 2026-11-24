/**
 * The handler on `node:http`, and the one thing a function from a request to a response cannot do:
 * the event stream. The runs are read once every `pollMs` for all the pages that listen, and a page
 * is told the list only when it changed.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { clientAddress } from "./address";
import { type Handler, MAX_BODY, type WebApi, type WebRequest } from "./handler";
import { MCP_PATH, type McpEndpoint } from "./mcp-http";

export interface WebServerOptions {
  handler: Handler;
  api: WebApi;
  /** How often the runs are read for the event stream. */
  pollMs?: number;
  /** A comment line to keep proxies from closing a quiet stream. */
  keepAliveMs?: number;
  /** `--mcp`: the endpoint at `/mcp`; without it that path is not found. */
  mcp?: McpEndpoint;
}

export interface WebServer {
  server: Server;
  /** Stops reading the runs and closes every stream; the sockets close with the server. */
  close(): Promise<void>;
}

function headersOf(req: IncomingMessage): WebRequest["headers"] {
  const out: WebRequest["headers"] = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      resolve(chunks.length === 0 ? undefined : Buffer.concat(chunks).toString("utf8")),
    );
    req.on("error", reject);
  });
}

export function startWebServer(options: WebServerOptions): WebServer {
  const { handler, api } = options;
  const pollMs = options.pollMs ?? 2_000;
  const keepAliveMs = options.keepAliveMs ?? 25_000;
  /** Each open stream, with the headers that opened it: the device is checked again at every tick. */
  const streams = new Map<ServerResponse, WebRequest["headers"]>();
  let last: { hash: string; text: string } | undefined;
  let polling = false;

  const send = (res: ServerResponse, text: string) =>
    res.write(`event: sessions\ndata: ${text}\n\n`);

  const poll = async () => {
    if (polling || streams.size === 0) return;
    polling = true;
    try {
      // A device revoked, or signed out, while its page listens is cut off at the next tick.
      for (const [res, headers] of [...streams]) {
        const still = await handler.authenticate(headers).catch(() => undefined);
        if (!still) {
          streams.delete(res);
          res.end();
        }
      }
      if (streams.size === 0) return;
      const loaded = await api.sessions();
      const text = JSON.stringify({ sessions: loaded.sessions, proposals: loaded.proposals });
      const hash = createHash("sha256").update(text).digest("hex");
      if (hash !== last?.hash) {
        last = { hash, text };
        for (const res of streams.keys()) send(res, text);
      }
    } catch {
      // A failed read is tried again at the next tick; the pages keep what they have.
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => void poll(), pollMs);
  const ping = setInterval(() => {
    for (const res of streams.keys()) res.write(": ping\n\n");
  }, keepAliveMs);
  timer.unref?.();
  ping.unref?.();

  const events = async (req: IncomingMessage, res: ServerResponse) => {
    const headers = headersOf(req);
    const device = await handler.authenticate(headers);
    if (!device) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end("not paired\n");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    streams.set(res, headers);
    req.on("close", () => streams.delete(res));
    if (last) send(res, last.text);
    else void poll();
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://local");
      if (url.pathname === MCP_PATH && options.mcp) {
        await options.mcp.handle(req, res);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        await events(req, res);
        return;
      }
      let body: string | undefined;
      try {
        body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      } catch {
        if (!res.headersSent) res.writeHead(413).end();
        return;
      }
      const answer = await handler.handle({
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: headersOf(req),
        ...(body === undefined ? {} : { body }),
        ip: clientAddress(req),
      });
      res.writeHead(answer.status, answer.headers);
      res.end(req.method === "HEAD" ? undefined : answer.body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;

  return {
    server,
    async close() {
      clearInterval(timer);
      clearInterval(ping);
      for (const res of streams.keys()) res.end();
      streams.clear();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
