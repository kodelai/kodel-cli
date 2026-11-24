/**
 * The tokens an MCP client sends to the web server's `/mcp` endpoint (`Authorization: Bearer ...`).
 * A person makes one at a terminal (`kodel web token add`) and sees it once; only its hash is kept. A
 * token serves the manager role, and only the tools that write nothing when it is read-only: a client
 * on another machine works no run (T-44).
 *
 * Machine-local state, beside the devices: `<state base>/web/tokens.json`, written with a `v`.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cleanName } from "./devices";
import { withFileLock } from "./file-lock";

/** A token's `lastUsedAt` is written at most this often, so that calls do not turn into writes. */
const USED_EVERY_MS = 60 * 60_000;
/** What a token starts with, so that it is known for what it is wherever it turns up. */
export const TOKEN_PREFIX = "kodel_";

export interface McpToken {
  id: string;
  name: string;
  /** Only the tools that write nothing. */
  readOnly: boolean;
  createdAt: number;
  lastUsedAt?: number;
}

interface StoredToken extends McpToken {
  /** sha256 of the secret part, hex. */
  hash: string;
}

interface TokenFile {
  v: 1;
  tokens: StoredToken[];
}

export class TokenStoreError extends Error {}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function decode(text: string): TokenFile {
  const data: unknown = JSON.parse(text);
  if (typeof data !== "object" || data === null) throw new TokenStoreError("not an object");
  const record = data as Record<string, unknown>;
  if (typeof record.v === "number" && record.v > 1) {
    throw new TokenStoreError("written by a newer kodel; upgrade kodel");
  }
  if (record.v !== 1) throw new TokenStoreError("has no known format version");
  const tokens = Array.isArray(record.tokens) ? record.tokens : [];
  return {
    v: 1,
    tokens: tokens.flatMap((t): StoredToken[] => {
      const r = t as Record<string, unknown>;
      if (
        typeof r.id !== "string" ||
        typeof r.name !== "string" ||
        typeof r.hash !== "string" ||
        typeof r.createdAt !== "number"
      ) {
        return [];
      }
      return [
        {
          id: r.id,
          name: r.name,
          hash: r.hash,
          // A token that does not say is read-only: the narrower reading of what it may do.
          readOnly: r.readOnly !== false,
          createdAt: r.createdAt,
          ...(typeof r.lastUsedAt === "number" ? { lastUsedAt: r.lastUsedAt } : {}),
        },
      ];
    }),
  };
}

export class TokenStore {
  readonly file: string;
  private readonly clock: () => number;
  private readonly random: (bytes: number) => Buffer;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    dir: string,
    deps: { clock?: () => number; random?: (bytes: number) => Buffer } = {},
  ) {
    this.file = join(dir, "tokens.json");
    this.clock = deps.clock ?? Date.now;
    this.random = deps.random ?? randomBytes;
  }

  private async read(): Promise<TokenFile> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, tokens: [] };
      throw error;
    }
    try {
      return decode(text);
    } catch (error) {
      throw new TokenStoreError(
        `cannot read ${this.file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async write(data: TokenFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.${this.random(4).toString("hex")}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.file);
    await chmod(this.file, 0o600).catch(() => undefined);
  }

  private change<T>(work: (data: TokenFile) => { data?: TokenFile; value: T }): Promise<T> {
    const next = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      return withFileLock(this.file, async () => {
        const result = work(await this.read());
        if (result.data) await this.write(result.data);
        return result.value;
      });
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** A new token; the token itself is returned once and never kept. */
  add(input: { name: string; readOnly: boolean }): Promise<{ token: string; info: McpToken }> {
    const id = this.random(6).toString("hex");
    const secret = this.random(32).toString("base64url");
    const stored: StoredToken = {
      id,
      name: cleanName(input.name),
      readOnly: input.readOnly,
      hash: sha256(secret),
      createdAt: this.clock(),
    };
    const { hash: _, ...info } = stored;
    return this.change((data) => ({
      data: { ...data, tokens: [...data.tokens, stored] },
      value: { token: `${TOKEN_PREFIX}${id}_${secret}`, info },
    }));
  }

  /** The token a bearer value belongs to, or nothing. */
  async verify(bearer: string | undefined): Promise<McpToken | undefined> {
    if (bearer === undefined || !bearer.startsWith(TOKEN_PREFIX)) return undefined;
    const rest = bearer.slice(TOKEN_PREFIX.length);
    const cut = rest.indexOf("_");
    if (cut <= 0) return undefined;
    const id = rest.slice(0, cut);
    const hash = sha256(rest.slice(cut + 1));
    const data = await this.read();
    const found = data.tokens.find((t) => t.id === id);
    if (!found || !sameHash(found.hash, hash)) return undefined;
    const now = this.clock();
    if (found.lastUsedAt === undefined || now - found.lastUsedAt > USED_EVERY_MS) {
      await this.change((current) => ({
        data: {
          ...current,
          tokens: current.tokens.map((t) => (t.id === id ? { ...t, lastUsedAt: now } : t)),
        },
        value: undefined,
      })).catch(() => undefined);
    }
    const { hash: _, ...info } = found;
    return info;
  }

  async list(): Promise<McpToken[]> {
    return (await this.read()).tokens.map(({ hash: _, ...info }) => info);
  }

  /** Takes a token out; a client that holds it is refused at its next call. Whether there was one. */
  revoke(id: string): Promise<boolean> {
    return this.change((data) => {
      const tokens = data.tokens.filter((t) => t.id !== id);
      return tokens.length === data.tokens.length
        ? { value: false }
        : { data: { ...data, tokens }, value: true };
    });
  }
}
