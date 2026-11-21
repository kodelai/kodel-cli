/**
 * The record of a running `kodel serve` (TASK-G8KM, T-43): `<state base>/serve/<uid>/<checkoutKey>.json`.
 * Machine-local, not history. One daemon per checkout holds it: `acquireServeRecord` makes it or
 * refuses while the recorded process is alive; the daemon rewrites it after each cycle and removes it
 * when it stops. The TUI and `kodel serve --status` read it with `readServeStatus`.
 */
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  decodeServeRecord,
  encodeServeRecord,
  SERVE_RECORD_VERSION,
  type ServeRecord,
} from "@kodel-ai/pipeline-core/serve";
import { type ProcessIdentity, processIdentity, sameProcess } from "../process-table";
import { sessionCheckoutKey } from "../session-paths";

/** A daemon that finished no cycle for this long is `silent`: the TUI offers its resumes again. */
export const SERVE_SILENT_MS = 120_000;

/** A takeover guard file older than this was left by a process that died while taking over. */
const GUARD_STALE_MS = 5_000;
/** A record that stays empty or half-written this long was left by a process that died while making it. */
const UNFINISHED_RECORD_MS = 5_000;

export interface ServePlace {
  /** The record's file. */
  file: string;
  /** The checkout it is for. */
  root: string;
  /** The state base (`KODEL_STATE_DIR`, else `~/.kodel`). */
  base: string;
}

const currentUid = (): number => (typeof process.getuid === "function" ? process.getuid() : 0);

/** Where the daemon of a checkout keeps its record; `base` comes from `resolveBase`. */
export function servePlace(input: { base: string; root: string; uid?: number }): ServePlace {
  const uid = input.uid ?? currentUid();
  return {
    file: join(input.base, "serve", String(uid), `${sessionCheckoutKey(input.root)}.json`),
    root: input.root,
    base: input.base,
  };
}

/** Why a daemon cannot take the record. */
export class ServeRecordRefused extends Error {
  constructor(
    readonly why: "running" | "unreadable" | "taken_over",
    message: string,
    readonly record?: ServeRecord,
  ) {
    super(message);
    this.name = "ServeRecordRefused";
  }
}

export interface ServeProcessCheck {
  /** Whether `pid` is still the process that wrote the record; `sameProcess` by default. */
  isSame?: (pid: number, identity: ProcessIdentity | undefined) => boolean;
}

export interface AcquireServeInput extends ServeProcessCheck {
  pid?: number;
  identity?: ProcessIdentity;
  now: number;
  build: string;
}

export type ServeCycleUpdate = Pick<ServeRecord, "state"> &
  Partial<Pick<ServeRecord, "reason" | "counts" | "cycle_at">>;

export interface ServeRecordHandle {
  readonly place: ServePlace;
  /** What the file says now, as this daemon wrote it last. */
  current(): ServeRecord;
  /**
   * Write the state after a cycle (a temporary file, then a rename). A failed write does not stop the
   * daemon: the caller logs it and the cycle goes on. A file that is no longer this daemon's is not
   * written: the error is a `ServeRecordRefused` (`taken_over`), and the daemon stops.
   */
  writeCycle(update: ServeCycleUpdate): Promise<{ ok: true } | { ok: false; error: unknown }>;
  /** Remove the record, if it is still this daemon's. */
  release(): Promise<void>;
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const isBusy = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EEXIST" ||
    (process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY"))
  );
};

const since = (ms: number) => new Date(ms).toISOString();

function runningMessage(record: ServeRecord): string {
  return `kodel serve is already running for this project (pid ${record.pid}, since ${since(record.started)})`;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

const NOT_JSON = "not JSON";

function decodeText(text: string) {
  try {
    return decodeServeRecord(JSON.parse(text));
  } catch {
    return { ok: false as const, code: "CANNOT_READ" as const, why: NOT_JSON };
  }
}

/** Write so that a reader sees the old text or the new; Windows may refuse a rename over an open file for a moment. */
async function writeAtomic(file: string, text: string, pid: number): Promise<void> {
  const tmp = `${file}.tmp-${pid}`;
  await rm(tmp, { force: true });
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (error) {
      if (!isBusy(error) || attempt >= 5) {
        await rm(tmp, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

/**
 * Take the record for this process: made with an exclusive create. A record whose process is alive
 * refuses with its pid and start; one whose process is gone (or whose pid now names another process)
 * is taken over behind a `.takeover` guard file, and only if its text is still what was judged. A
 * record that cannot be read, or is written by a newer kodel, refuses and names the file.
 */
export async function acquireServeRecord(
  place: ServePlace,
  input: AcquireServeInput,
): Promise<ServeRecordHandle> {
  const pid = input.pid ?? process.pid;
  const isSame = input.isSame ?? sameProcess;
  const identity = input.identity ?? processIdentity(pid);
  let record: ServeRecord = {
    v: SERVE_RECORD_VERSION,
    pid,
    ...(identity === undefined ? {} : { identity }),
    started: input.now,
    state: "idle",
    root: place.root,
    state_base: place.base,
    build: input.build,
  };
  await mkdir(dirname(place.file), { recursive: true, mode: 0o700 });
  let made = false;
  let unfinished = false;
  for (let round = 0; round < 20 && !made; round++) {
    try {
      const handle = await open(place.file, "wx", 0o600);
      try {
        await handle.writeFile(encodeServeRecord(record));
      } finally {
        await handle.close();
      }
      made = true;
      break;
    } catch (error) {
      if (!isBusy(error)) throw error;
    }
    const text = await readText(place.file);
    if (text === undefined) continue;
    const decoded = decodeText(text);
    unfinished = text === "" || (!decoded.ok && decoded.why === NOT_JSON);
    if (unfinished) {
      // Made a moment ago and not written yet by its maker, or left so by a maker that died.
      const modified = await stat(place.file).then(
        (s) => s.mtimeMs,
        () => input.now,
      );
      if (Date.now() - modified > UNFINISHED_RECORD_MS) await takeOver(place.file, text);
      else await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }
    if (!decoded.ok) {
      throw new ServeRecordRefused(
        "unreadable",
        `the record of kodel serve cannot be read (${decoded.why}): ${place.file}; remove it if no kodel serve runs for this project`,
      );
    }
    if (isSame(decoded.record.pid, decoded.record.identity)) {
      throw new ServeRecordRefused("running", runningMessage(decoded.record), decoded.record);
    }
    await takeOver(place.file, text);
  }
  if (!made) {
    throw unfinished
      ? new ServeRecordRefused(
          "unreadable",
          `the record of kodel serve is not written yet (another kodel serve may be starting): ${place.file}; try again in a few seconds, or remove it if no kodel serve runs for this project`,
        )
      : new ServeRecordRefused("running", "kodel serve is being started by another process");
  }
  /** Whether the file is still this daemon's (its pid and start); an error when it cannot be read. */
  const stillOwn = async (): Promise<boolean | Error> => {
    let text: string | undefined;
    try {
      text = await readText(place.file);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    if (text === undefined) return false;
    const decoded = decodeText(text);
    return decoded.ok && decoded.record.pid === pid && decoded.record.started === record.started;
  };
  const handle: ServeRecordHandle = {
    place,
    current: () => record,
    writeCycle: async (update) => {
      const own = await stillOwn();
      if (own !== true) {
        return {
          ok: false,
          error:
            own === false
              ? new ServeRecordRefused(
                  "taken_over",
                  `another kodel serve took over the record ${place.file}`,
                )
              : own,
        };
      }
      const next: ServeRecord = {
        ...record,
        state: update.state,
        ...(update.cycle_at === undefined ? {} : { cycle_at: update.cycle_at }),
        ...(update.counts === undefined ? {} : { counts: update.counts }),
      };
      if (update.reason === undefined) delete next.reason;
      else next.reason = update.reason;
      try {
        await writeAtomic(place.file, encodeServeRecord(next), pid);
        record = next;
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    },
    release: async () => {
      if ((await stillOwn()) === true) await rm(place.file, { force: true });
    },
  };
  return handle;
}

/** Remove a record whose process is gone; one taker at a time, and only the text that was judged. */
async function takeOver(file: string, judged: string): Promise<void> {
  const guard = `${file}.takeover`;
  let held: Awaited<ReturnType<typeof open>>;
  try {
    held = await open(guard, "wx");
  } catch (error) {
    if (!isBusy(error)) throw error;
    const modified = await stat(guard).then(
      (s) => s.mtimeMs,
      () => Date.now(),
    );
    if (Date.now() - modified > GUARD_STALE_MS) await rm(guard, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return;
  }
  try {
    await held.close();
    if ((await readText(file)) === judged) await rm(file, { force: true });
  } finally {
    await rm(guard, { force: true });
  }
}

export type ServeStatus =
  | { kind: "off"; why: string }
  | { kind: "active" | "idle" | "silent"; record: ServeRecord }
  | { kind: "unknown"; why: string };

/**
 * Whether a daemon serves the checkout: `off` (no record, its process is gone, or Windows, where no
 * daemon runs and nothing is read), `active`, `idle` (on, but its block is off or its config does not
 * load), `silent` (alive, but no cycle finished for 2 min), `unknown` (the record cannot be read).
 */
export async function readServeStatus(
  place: ServePlace,
  now: number,
  options: ServeProcessCheck & { platform?: NodeJS.Platform } = {},
): Promise<ServeStatus> {
  if ((options.platform ?? process.platform) === "win32") {
    return { kind: "off", why: "kodel serve does not run on Windows" };
  }
  let text: string | undefined;
  try {
    text = await readText(place.file);
  } catch (error) {
    return { kind: "unknown", why: error instanceof Error ? error.message : String(error) };
  }
  if (text === undefined) return { kind: "off", why: "no kodel serve runs for this project" };
  const decoded = decodeText(text);
  if (!decoded.ok) return { kind: "unknown", why: `${decoded.why}: ${place.file}` };
  const record = decoded.record;
  const isSame = options.isSame ?? sameProcess;
  if (!isSame(record.pid, record.identity)) {
    return { kind: "off", why: `kodel serve (pid ${record.pid}) is gone` };
  }
  if (now - (record.cycle_at ?? record.started) > SERVE_SILENT_MS)
    return { kind: "silent", record };
  return { kind: record.state, record };
}
