/**
 * The address a request comes from, for counting wrong codes and tokens. Behind a proxy on this machine
 * (a TLS proxy, Tailscale Serve) every request comes from the loopback, so the address the proxy forwards
 * is taken instead: otherwise one client's wrong tries would lock every client out. A forwarded address
 * is believed only from the loopback, where nobody but a local proxy can send it.
 */
import type { IncomingMessage } from "node:http";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function clientAddress(req: Pick<IncomingMessage, "headers" | "socket">): string {
  const peer = req.socket.remoteAddress ?? "";
  if (!LOOPBACK.has(peer)) return peer;
  const raw = req.headers["x-forwarded-for"];
  const forwarded = (Array.isArray(raw) ? raw.join(",") : (raw ?? ""))
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "");
  // The proxy appends the address it saw: the last one is the one it vouches for.
  return forwarded.at(-1)?.slice(0, 100) ?? peer;
}
