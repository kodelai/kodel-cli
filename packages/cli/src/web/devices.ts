/**
 * The devices that may open the web UI: a phone or a browser is paired once, with a one-time code that
 * only a person at a terminal is shown (`kodel web pair`), and then carries a long random token in a
 * cookie. Only hashes are kept: the file gives nobody a way in.
 *
 * Machine-local state, like the session records: `<state base>/web/devices.json`, written with a `v`.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "./file-lock";

/** How long a pairing code can be used, once. */
export const PAIRING_TTL_MS = 5 * 60_000;
/** A device's `lastSeenAt` is written at most this often, so that reads do not turn into writes. */
const SEEN_EVERY_MS = 60 * 60_000;
/** Pairing codes kept at once; an older one is dropped when a new one is made. */
const MAX_PAIRINGS = 5;

export interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt?: number;
}

interface StoredDevice extends Device {
  /** sha256 of the token, hex. */
  hash: string;
}

interface StoredPairing {
  hash: string;
  expiresAt: number;
}

interface DeviceFile {
  v: 1;
  devices: StoredDevice[];
  pairings: StoredPairing[];
}

export class DeviceStoreError extends Error {}

export interface DeviceStoreDeps {
  clock?: () => number;
  random?: (bytes: number) => Buffer;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function decode(text: string): DeviceFile {
  const data: unknown = JSON.parse(text);
  if (typeof data !== "object" || data === null) throw new DeviceStoreError("not an object");
  const record = data as Record<string, unknown>;
  if (typeof record.v === "number" && record.v > 1) {
    throw new DeviceStoreError("written by a newer kodel; upgrade kodel");
  }
  if (record.v !== 1) throw new DeviceStoreError("has no known format version");
  const devices = Array.isArray(record.devices) ? record.devices : [];
  const pairings = Array.isArray(record.pairings) ? record.pairings : [];
  return {
    v: 1,
    devices: devices.flatMap((d): StoredDevice[] => {
      const r = d as Record<string, unknown>;
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
          createdAt: r.createdAt,
          ...(typeof r.lastSeenAt === "number" ? { lastSeenAt: r.lastSeenAt } : {}),
        },
      ];
    }),
    pairings: pairings.flatMap((p): StoredPairing[] => {
      const r = p as Record<string, unknown>;
      return typeof r.hash === "string" && typeof r.expiresAt === "number"
        ? [{ hash: r.hash, expiresAt: r.expiresAt }]
        : [];
    }),
  };
}

/** A device name as typed on a phone: one short line of plain text. */
export function cleanName(name: string): string {
  const flat = [...name]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0);
    })
    .join("")
    .trim();
  return [...flat].slice(0, 60).join("") || "device";
}

export class DeviceStore {
  readonly file: string;
  private readonly clock: () => number;
  private readonly random: (bytes: number) => Buffer;
  /** Writes are queued: two requests of one server never interleave a read and a write. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, deps: DeviceStoreDeps = {}) {
    this.file = join(dir, "devices.json");
    this.clock = deps.clock ?? Date.now;
    this.random = deps.random ?? randomBytes;
  }

  private async read(): Promise<DeviceFile> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { v: 1, devices: [], pairings: [] };
      }
      throw error;
    }
    try {
      return decode(text);
    } catch (error) {
      throw new DeviceStoreError(
        `cannot read ${this.file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async write(data: DeviceFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.${this.random(4).toString("hex")}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.file);
    await chmod(this.file, 0o600).catch(() => undefined);
  }

  private change<T>(work: (data: DeviceFile) => { data?: DeviceFile; value: T }): Promise<T> {
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

  /** A new one-time code; the code itself is returned once and never kept. */
  createPairing(ttlMs = PAIRING_TTL_MS): Promise<{ code: string; expiresAt: number }> {
    const code = this.random(16).toString("base64url");
    const now = this.clock();
    const expiresAt = now + ttlMs;
    return this.change((data) => ({
      data: {
        ...data,
        pairings: [
          ...data.pairings.filter((p) => p.expiresAt > now).slice(-(MAX_PAIRINGS - 1)),
          { hash: sha256(code), expiresAt },
        ],
      },
      value: { code, expiresAt },
    }));
  }

  /** Uses a code up and pairs a device: its cookie value, or nothing for a code that is wrong, used or old. */
  redeemPairing(
    code: string,
    name: string,
  ): Promise<{ device: Device; credential: string } | undefined> {
    const now = this.clock();
    const hash = sha256(code);
    return this.change((data) => {
      const live = data.pairings.filter((p) => p.expiresAt > now);
      const found = live.find((p) => sameHash(p.hash, hash));
      if (!found) {
        return live.length === data.pairings.length
          ? { value: undefined }
          : { data: { ...data, pairings: live }, value: undefined };
      }
      const id = this.random(6).toString("hex");
      const token = this.random(32).toString("base64url");
      const device: StoredDevice = {
        id,
        name: cleanName(name),
        hash: sha256(token),
        createdAt: now,
      };
      const { hash: _, ...shown } = device;
      return {
        data: {
          ...data,
          devices: [...data.devices, device],
          pairings: live.filter((p) => p !== found),
        },
        value: { device: shown, credential: `${id}.${token}` },
      };
    });
  }

  /** The device a cookie value belongs to, or nothing. */
  async verify(credential: string | undefined): Promise<Device | undefined> {
    if (credential === undefined) return undefined;
    const dot = credential.indexOf(".");
    if (dot <= 0) return undefined;
    const id = credential.slice(0, dot);
    const hash = sha256(credential.slice(dot + 1));
    const data = await this.read();
    const found = data.devices.find((d) => d.id === id);
    if (!found || !sameHash(found.hash, hash)) return undefined;
    const now = this.clock();
    if (found.lastSeenAt === undefined || now - found.lastSeenAt > SEEN_EVERY_MS) {
      await this.change((current) => ({
        data: {
          ...current,
          devices: current.devices.map((d) => (d.id === id ? { ...d, lastSeenAt: now } : d)),
        },
        value: undefined,
      })).catch(() => undefined);
    }
    const { hash: _, ...shown } = found;
    return shown;
  }

  async list(): Promise<Device[]> {
    return (await this.read()).devices.map(({ hash: _, ...shown }) => shown);
  }

  /** Takes a device out; its cookie stops working at once. Whether there was one. */
  revoke(id: string): Promise<boolean> {
    return this.change((data) => {
      const devices = data.devices.filter((d) => d.id !== id);
      return devices.length === data.devices.length
        ? { value: false }
        : { data: { ...data, devices }, value: true };
    });
  }
}
